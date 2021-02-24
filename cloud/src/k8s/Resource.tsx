/*
 * Copyright 2018-2020 Unbounded Systems, LLC
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

import Adapt, {
    AdaptElement,
    AdaptMountedElement,
    BuildData,
    BuiltinProps,
    ChangeType,
    childrenToArray,
    DeployHelpers,
    DeployStatus,
    errorToNoStatus,
    FinalDomElement,
    GoalStatus,
    gqlGetOriginalErrors,
    isElement,
    isFinalDomElement,
    ObserveForStatus,
    waiting,
} from "@adpt/core";
import * as ld from "lodash";

import { InternalError } from "@adpt/utils";
import * as yup from "yup";
import { Action, ActionContext, ShouldAct } from "../action";
import { mountedElement } from "../common";
import { ResourceProps, ResourcePropsWithConfig } from "./common";
import { kubectlDiff, kubectlGet, kubectlOpManifest } from "./kubectl";
import {
    getResourceInfo,
    makeManifest,
    Manifest,
} from "./manifest_support";

/**
 * Type assertion to see if an element is both a {@link k8s.Resource | Resource}
 * and a {@link @adpt/core#FinalElement | FinalElement}
 *
 * @param e - element to test
 * @returns `true` if e is both a FinalElement and a {@link k8s.Resource | Resource}, `false` otherwise
 *
 * @public
 */
export function isResourceFinalElement(e: AdaptElement):
    e is FinalDomElement<ResourceProps & Adapt.BuiltinProps> {
    return isFinalDomElement(e) && e.componentType === Resource;
}

/**
 * Decides if an existing Resource is scheduled for deletion
 */
function isDeleting(info: Manifest | undefined): boolean {
    return (info !== undefined) && ("deletionTimestamp" in info.metadata);
}

/**
 * Primitive Component recognized by the k8s plugin to represent resources
 * @public
 */
export class Resource extends Action<ResourceProps> {
    defaultProps: {
        apiVersion: "v1";
        con: false;
    };

    manifest_: Manifest;

    constructor(props: ResourceProps) {
        super(props);
    }

    validate() {
        const children = childrenToArray((this.props as any).children);

        if (!ld.isEmpty(children)) return "Resource elements cannot have children";
        if (!this.props.isTemplate && this.props.config === undefined) {
            throw new Error("Non-template Resource elements must have a config prop");
        }

        yup.object().shape({
            kubeconfig: yup.object().shape({ "current-context": yup.string() }).required(),
            registry: yup.mixed().oneOf([
                yup.object().shape({ internal: yup.string().url(), external: yup.string().url() }),
                yup.string().url()
            ])
        }).validateSync(this.props.config);

        //Do other validations of Specs here
    }

    async shouldAct(op: ChangeType, ctx: ActionContext): Promise<ShouldAct> {
        if (!isResourcePropsWithConfig(this.props)) return false;

        const kubeconfig = this.props.config.kubeconfig;
        const deployID = ctx.buildData.deployID;
        const manifest = this.manifest(deployID);
        const { name, namespace } = manifest.metadata;
        const kind = manifest.kind;
        const oldManifest = await kubectlGet({
            kubeconfig,
            name,
            namespace,
            kind
        });

        switch (op) {
            case ChangeType.create:
            case ChangeType.modify:
            case ChangeType.replace:
                if (oldManifest === undefined || isDeleting(oldManifest)) {
                    return {
                        act: true,
                        detail: `Creating ${kind} ${name}`
                    };
                } else {
                    const { forbidden, diff } = await kubectlDiff({
                        kubeconfig,
                        manifest
                    });
                    const opStr = (forbidden || (op === ChangeType.replace)) ? "Replacing" : "Updating";
                    if (((diff !== undefined) && (diff !== "")) || forbidden) {
                        return {
                            act: true,
                            detail: `${opStr} ${kind} ${name}`
                        };
                    }
                }
                return false;
            case ChangeType.delete:
                if (oldManifest && !isDeleting(oldManifest)) {
                    return {
                        act: true,
                        detail: `Deleting ${kind} ${name}`
                    };
                }
                return false;
            case ChangeType.none:
                return false;
        }
    }

    async action(op: ChangeType, ctx: ActionContext): Promise<void> {
        if (!isResourcePropsWithConfig(this.props)) return;

        const kubeconfig = this.props.config.kubeconfig;
        const deployID = ctx.buildData.deployID;
        const manifest = this.manifest(deployID);
        const { name, namespace } = manifest.metadata;
        const kind = manifest.kind;
        const info = await kubectlGet({
            kubeconfig,
            name,
            namespace,
            kind
        });
        let deleted = false;

        if (isDeleting(info)) {
            //Wait for deleting to complete, else create/modify/apply will fail
            await kubectlOpManifest("delete", {
                kubeconfig,
                manifest,
                wait: true
            });
            deleted = true;
        }

        if (op === ChangeType.modify) {
            const { forbidden } = await kubectlDiff({
                kubeconfig,
                manifest
            });
            op = (op === ChangeType.modify) && forbidden ? ChangeType.replace : op;
        }
        switch (op) {
            case ChangeType.create:
            case ChangeType.modify:
                await kubectlOpManifest("apply", {
                    kubeconfig,
                    manifest
                });
                return;
            case ChangeType.replace:
                if (!deleted) {
                    await kubectlOpManifest("delete", {
                        kubeconfig,
                        manifest,
                        wait: true
                    });
                }
                await kubectlOpManifest("apply", {
                    kubeconfig,
                    manifest
                });
                return;
            case ChangeType.delete:
                if (deleted) return;
                await kubectlOpManifest("delete", {
                    kubeconfig,
                    manifest,
                    wait: false
                });
                return;
            case ChangeType.none:
                return;
        }
    }

    deployedWhen = async (goalStatus: GoalStatus, helpers: DeployHelpers) => {
        if (!isResourcePropsWithConfig(this.props)) return true;

        const kind = this.props.kind;
        const info = getResourceInfo(kind);
        const hand = this.props.handle;
        if (!info) throw new Error(`Invalid Resource kind ${kind}`);
        if (!hand) throw new Error("Invalid handle");
        try {
            const statObj = await helpers.elementStatus<any>(hand);
            if (goalStatus === DeployStatus.Destroyed) {
                return waiting(`Waiting for ${kind} to be destroyed`);
            }
            return info.deployedWhen(statObj, DeployStatus.Deployed);
        } catch (err) {
            if (ld.isError(err) && err.name === "K8sNotFound") {
                if (goalStatus === DeployStatus.Destroyed) return true;
                return waiting(`${kind} not present`);
            }
            throw err;
        }
    }

    async status(observe: ObserveForStatus, buildData: BuildData) {
        if (!isResourcePropsWithConfig(this.props)) return { noStatus: "no status for template resources" };
        const info = getResourceInfo(this.props.kind);
        const statusQuery = info && info.statusQuery;
        if (!statusQuery) return { noStatus: "no status query defined for this kind" };
        if (!isResourcePropsWithConfig(this.props)) throw new InternalError("Resource config is undefined");
        try {
            return await statusQuery(this.props, observe, buildData);
        } catch (err) {
            // If there's only one GQL error and it's K8sNotFound, throw
            // that on up the stack. Otherwise, return a Status object.
            const orig = gqlGetOriginalErrors(err);
            if (orig && orig.length === 1 && orig[0].name === "K8sNotFound") {
                throw orig[0];
            }
            return errorToNoStatus(err);
        }
    }

    private mountedElement(): AdaptMountedElement<ResourceProps> {
        return mountedElement(this.props as Required<BuiltinProps>);
    }

    private manifest(deployID: string): Manifest {
        if (this.manifest_) return this.manifest_;
        const elem = this.mountedElement();
        const manifest = makeManifest(elem, deployID);
        const info = getResourceInfo(this.props.kind);
        this.manifest_ = info.makeManifest ? info.makeManifest(manifest, elem, deployID) : manifest;
        return this.manifest_;
    }
}

/**
 * Tests whether a ResourceProps is for a template object
 *
 * @public
 */
export function isResourcePropsWithConfig(x: ResourceProps & Partial<BuiltinProps>):
    x is ResourcePropsWithConfig & Partial<BuiltinProps> {
    return (!x.isTemplate) && (x.config !== undefined);
}

/**
 * Tests to see if an object is a {@link k8s.Resource} element
 * @param x - object to test
 * @returns true if object is an AdaptElement of type {@link k8s.Resource}
 *
 * @public
 */
export function isResource(x: any): x is AdaptElement<ResourceProps> {
    return isElement(x) && x.componentType === Resource;
 }
