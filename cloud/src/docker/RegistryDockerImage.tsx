/*
 * Copyright 2019-2020 Unbounded Systems, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { callFirstInstanceWithMethod, callInstanceMethod, ChangeType, DependsOnMethod, Handle, isHandle } from "@adpt/core";
import { InternalError, MaybePromise } from "@adpt/utils";
import { isEqual } from "lodash";
import { URL } from "url";
import { isString } from "util";
import { Action } from "../action";
import { DockerImageInstance, DockerPushableImageInstance } from "./DockerImage";
import { ImageRef, ImageRefRegistry, mutableImageRef } from "./image-ref";
import { DockerSplitRegistryInfo, NameTagString, RegistryString } from "./types";

/**
 * Props for {@link docker.RegistryDockerImage}
 * @public
 */
export interface RegistryDockerImageProps {
    /**
     * Handle for image source
     * @remarks
     * Currently, only handle to LocalDockerImage components and compatible
     * interfaces are supported.
     * @privateRemarks
     * FIXME(manishv) support string refs to other registries and handles of
     * other registry images
     */
    imageSrc: Handle<DockerPushableImageInstance>;
    /**
     * URL or string for the registry where the image should be pushed and pulled
     *
     * @remarks
     * If this parameter is a string, registryUrl will be used for both push and pull
     *
     * If registryUrl is of the form `{ external: string, internal: string }`, docker images wil be
     * pushed to `external` and image strings will refer to `internal`.
     *
     * Note(manishv)
     * This is a bit of a hack to allow one hostname or IP address to push images from outside
     * a particular environment (say k8s) and a different URL for that environment to pull
     * images.
     *
     * A good example of this is a k3s-dind (k3s docker-in-docker) instance of kubernetes where
     * a private registry is running on a docker network attached to the k3s-dind instance, but where we
     * want to push {@link docker.LocalDockerImage} built images to that registry.  Since
     * {@link docker.LocalDockerImage | LocalDockerImage} is outside the k3s-dind environment, it must
     * use a host accessible network to push to the registry.  However, since the k3s-dind instance sees
     * the registry from within Docker, it must use a different address to pull the images for use.
     *
     * Once network scopes are fully supported, this interface will change to whatever is appropriate.  It
     * is best if you can arrange to have the same URL or registry string work for all access regardless
     * of which network the registry, Adapt host, and ultimate container running environment is uses.
     */
    registryUrl: string | DockerSplitRegistryInfo;

    /**
     * Path and tag to be used for the image in the new registry in
     * `path:tag` or `path` format.
     * @remarks
     * If omitted, the path and tag from the source image is used. The
     * newPathTag should not include the registry hostname/port prefix. If the
     * `:tag` portion of `path:tag` is omitted, the tag `latest` will be used.
     */
    newPathTag?: string;

    /**
     * Path and tag to be used for the image in the new registry in
     * `path:tag` or `path` format.
     * @deprecated This prop has been renamed to `newPathTag`. The functionality
     * for both props is the same and if both are set, `newPathTag` takes
     * priority.
     * @remarks
     * If omitted, the path and tag from the source image is used. The
     * newTag should not include the registry hostname/port prefix. If the
     * `:tag` portion of `path:tag` is omitted, the tag `latest` will be used.
     */
    newTag?: string;
}

interface State {
    image?: ImageRefRegistry;
    registryUrl?: DockerSplitRegistryInfo;
}

function buildNameTag(url: string, pathTag: string | undefined): NameTagString | undefined {
    if (pathTag === undefined) return undefined;
    const ref = mutableImageRef();
    ref.pathTag = pathTag;  // defaults tag to 'latest' if not present
    ref.domain = url;
    if (!ref.registryTag) throw new InternalError(`Image reference '${ref.ref}' does not have a registryTag`);
    return ref.registryTag;
}

function urlToRegistryString(registryUrl: string): RegistryString {
    let ret: string;
    if (registryUrl.startsWith("http")) {
        const parsed = new URL(registryUrl);
        ret = parsed.host + parsed.pathname;
    } else {
        ret = registryUrl;
    }
    if (ret.endsWith("/")) ret = ret.slice(0, -1);
    return ret;
}

function normalizeRegistryUrl(url: string | DockerSplitRegistryInfo) {
    if (isString(url)) url = { external: url, internal: url };
    return {
        external: urlToRegistryString(url.external),
        internal: urlToRegistryString(url.internal)
    };
}

/**
 * Represents a Docker image in a registry.
 * @remarks
 * If the image does not exist in the specified registry, it will be pushed
 * to that registry.
 * @public
 */
export class RegistryDockerImage extends Action<RegistryDockerImageProps, State>
    implements DockerImageInstance {

    private latestImage_?: ImageRefRegistry;
    private latestRegistryUrl_?: DockerSplitRegistryInfo;
    private registry: { external: RegistryString, internal: RegistryString };

    constructor(props: RegistryDockerImageProps) {
        super(props);

        this.registry = normalizeRegistryUrl(props.registryUrl);
    }

    /**
     * Returns information about the version of the Docker image that reflects
     * the current set of props for the component and has been pushed to the
     * registry.
     * @remarks
     * Returns undefined if the `props.imageSrc` component's `latestImage` method
     * returns undefined (depending on the component referenced by
     * `props.imageSrc`, that may indicate the source image has not been built).
     * Also returns undefined if the current image has not yet been
     * pushed to the registry.
     */
    image() {
        const srcImage = callInstanceMethod<ImageRef | undefined>(this.props.imageSrc, undefined, "latestImage");
        const latestImg = this.latestImage();
        const latestReg = this.latestRegistryUrl_ || this.state.registryUrl;
        if (!srcImage || !latestImg || !latestReg) return undefined;
        if (srcImage.id === latestImg.id &&
            this.currentNameTag(srcImage.pathTag) === latestImg.nameTag &&
            isEqual(this.registry, latestReg)) {
            return latestImg;
        }
        return undefined; // Pushed image is not current
    }
    /**
     * Returns information about the most current version of the Docker image
     * that has been pushed to the registry.
     * @remarks
     * Returns undefined if no image has ever been pushed by this component.
     */
    latestImage() { return this.latestImage_ || this.state.image; }

    /** @internal */
    initialState() { return {}; }

    /** @internal */
    shouldAct(diff: ChangeType) {
        if (diff === ChangeType.delete) return false;
        let name = this.getNewPathTag() || this.srcImageName();
        name = name ? ` '${name}'` : "";
        return { act: true, detail: `Pushing image${name} to ${this.registry.external}` };
    }

    /** @internal */
    dependsOn: DependsOnMethod = (_goalStatus, helpers) => {
        if (!isHandle(this.props.imageSrc)) return undefined;
        return helpers.dependsOn(this.props.imageSrc);
    }

    /** @internal */
    async action(op: ChangeType): Promise<void> {
        if (op === ChangeType.delete || op === ChangeType.none) return;
        const info = await callInstanceMethod<MaybePromise<ImageRefRegistry | undefined>>(
            this.props.imageSrc,
            undefined,
            "pushTo", this.registry.external, this.getNewPathTag());
        if (info === undefined) {
            throw new Error(`Image source component did not push image to registry`);
        }

        this.latestImage_ = { ...info };
        this.latestRegistryUrl_ = this.registry;
        this.setState({
            image: this.latestImage_,
            registryUrl: this.latestRegistryUrl_,
        });
    }

    private currentNameTag(pathTag: string | undefined): NameTagString | undefined {
        return buildNameTag(this.registry.internal, this.getNewPathTag() || pathTag);
    }

    private getNewPathTag() {
        return this.props.newPathTag || this.props.newTag;
    }

    private srcImageName() {
        return callFirstInstanceWithMethod<string | undefined>(this.props.imageSrc, undefined, "displayName");
    }
}
