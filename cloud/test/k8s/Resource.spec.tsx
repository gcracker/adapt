/*
 * Copyright 2018-2021 Unbounded Systems, LLC
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
    ChangeType,
    Group,
    isMountedElement,
    PluginOptions
} from "@adpt/core";
import should from "should";

import { createMockLogger, k8sutils, MockLogger } from "@adpt/testutils";
import { sleep } from "@adpt/utils";
import { ActionPlugin, createActionPlugin } from "../../src/action";
import {
    ClusterInfo,
    Kubeconfig,
    Resource,
    resourceElementToName,
} from "../../src/k8s";
import { kubectlOpManifest } from "../../src/k8s/kubectl";
import { deployIDToLabel, labelKey, Manifest } from "../../src/k8s/manifest_support";
import { mkInstance } from "../run_minikube";
import { act, checkNoActions, doBuild, randomName } from "../testlib";
import { forceK8sObserverSchemaLoad, K8sTestStatusType } from "./testlib";

const { deleteAll, getAll } = k8sutils;

// tslint:disable-next-line: no-object-literal-type-assertion
const dummyConfig = {} as ClusterInfo;

describe("k8s Resource Component Tests", () => {
    it("Should Instantiate Resource", () => {
        const resElem =
            <Resource key="test" kind="Pod" config={dummyConfig} spec={{
                containers: [{
                    name: "test",
                    image: "dummy-image",
                }]
            }} />;

        should(resElem).not.Undefined();
    });
});

describe("k8s Resource Tests (Resource, Pod)", function () {
    this.timeout(60 * 1000);

    let plugin: ActionPlugin;
    let logger: MockLogger;
    let options: PluginOptions;
    let clusterInfo: ClusterInfo;
    let client: k8sutils.KubeClient;
    let deployID: string | undefined;
    const testNamespace = "utility-function-test";
    const testNamespaceManifest: Manifest = {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
            name: testNamespace,
        }
    };

    before(async function () {
        this.timeout(mkInstance.setupTimeoutMs);
        this.slow(20 * 1000);
        clusterInfo = { kubeconfig: await mkInstance.kubeconfig as Kubeconfig };
        client = await mkInstance.client;
        forceK8sObserverSchemaLoad();
        await kubectlOpManifest("create", {
            kubeconfig: clusterInfo.kubeconfig,
            manifest: testNamespaceManifest,
        });
    });

    beforeEach(async () => {
        plugin = createActionPlugin();
        logger = createMockLogger();
        deployID = randomName("cloud-k8s-plugin");
        options = {
            dataDir: "/fake/datadir",
            deployID,
            logger,
            log: logger.info,
        };
    });

    afterEach(async function () {
        this.timeout(40 * 1000);
        if (client) {
            await deleteAll("pods", { client, deployID });
            await deleteAll("services", { client, deployID });
        }
    });

    after(async () => {
        await kubectlOpManifest("delete", {
            kubeconfig: clusterInfo.kubeconfig,
            manifest: testNamespaceManifest,
        });
    });

    function createPodDom(name: string, namespace?: string) {
        return (
            <Resource key={name}
                config={clusterInfo}
                kind="Pod"
                metadata={{
                    namespace,
                }}
                spec={{
                    containers: [{
                        name: "container",
                        image: "alpine:3.8",
                        command: ["sleep", "3s"],
                    }],
                    terminationGracePeriodSeconds: 0
                }} />
        );
    }

    async function createPod(name: string, namespace?: string) {
        if (!deployID) throw new Error(`Missing deployID?`);
        const resElem = createPodDom(name, namespace);

        const { mountedOrig, dom } = await doBuild(resElem, { deployID });
        if (!isMountedElement(dom)) {
            throw should(isMountedElement(dom)).True();
        }

        await plugin.start(options);
        const obs = await plugin.observe(null, dom);
        const actions = plugin.analyze(null, dom, obs);
        should(actions).length(1);
        should(actions[0].type).equal(ChangeType.create);
        should(actions[0].detail).startWith("Creating Pod");
        should(actions[0].changes).have.length(1);
        should(actions[0].changes[0].type).equal(ChangeType.create);
        should(actions[0].changes[0].detail).startWith("Creating Pod");
        should(actions[0].changes[0].element.componentName).equal("Resource");
        should(actions[0].changes[0].element.props.key).equal(name);

        await act(actions);

        const pods = await getAll("pods", { client, deployID, namespaces: ["default", testNamespace] });
        should(pods).length(1);
        should(pods[0].metadata.name)
            .equal(resourceElementToName(dom, options.deployID));
        should(pods[0].metadata.annotations).containEql({ [labelKey("name")]: dom.id });

        if (mountedOrig === null) throw should(mountedOrig).not.Null();
        const status = await mountedOrig.status<K8sTestStatusType>();
        should(status.kind).equal("Pod");
        should(status.metadata.name).equal(resourceElementToName(dom, options.deployID));
        should(status.metadata.annotations).containEql({ [labelKey("name")]: dom.id });
        should(status.metadata.labels).eql({
            [labelKey("deployID")]: deployIDToLabel(options.deployID),
            [labelKey("name")]: resourceElementToName(dom, options.deployID)
        });

        await plugin.finish();
        return dom;
    }

    it("Should create pod", async () => {
        await createPod("test");
    });

    it("Should modify pod", async () => {
        if (!deployID) throw new Error(`Missing deployID?`);
        const oldDom = await createPod("test");

        //5s sleep diff to cause modify vs. 3s sleep in createPod
        const command = ["sleep", "5s"];
        const resElem = <Resource key="test"
            config={clusterInfo}
            kind="Pod"
            spec={{
                containers: [{
                    name: "container",
                    image: "alpine:3.8",
                    command,
                }],
                terminationGracePeriodSeconds: 0
            }} />;

        const { dom } = await doBuild(resElem, { deployID });

        await plugin.start(options);
        const obs = await plugin.observe(oldDom, dom);
        const actions = plugin.analyze(oldDom, dom, obs);
        should(actions).length(1);
        should(actions[0].type).equal(ChangeType.modify);
        should(actions[0].detail).startWith("Replacing Pod");
        should(actions[0].changes).have.length(1);
        should(actions[0].changes[0].type).equal(ChangeType.modify);
        should(actions[0].changes[0].detail).startWith("Replacing Pod");
        should(actions[0].changes[0].element.componentName).equal("Resource");
        should(actions[0].changes[0].element.props.key).equal("test");

        await act(actions);

        const pods = await getAll("pods", { client, deployID });
        should(pods).length(1);
        should(pods[0].metadata.name)
            .equal(resourceElementToName(dom, options.deployID));
        should(pods[0].spec.containers).length(1);
        should(pods[0].spec.containers[0].command).eql(command);

        await plugin.finish();
    });

    it("Should leave pod alone", async () => {
        const oldDom = await createPod("test");

        //No diff
        const command = ["sleep", "3s"];
        const resElem = <Resource key="test"
            config={clusterInfo}
            kind="Pod"
            spec={{
                containers: [{
                    name: "container",
                    image: "alpine:3.8",
                    imagePullPolicy: "IfNotPresent",
                    command,
                }],
                terminationGracePeriodSeconds: 0
            }} />;

        const { dom } = await doBuild(resElem, { deployID });

        await plugin.start(options);
        const obs = await plugin.observe(oldDom, dom);
        const actions = plugin.analyze(oldDom, dom, obs);
        checkNoActions(actions, dom);
        await plugin.finish();
    });

    it("Should delete pod", async () => {
        if (!deployID) throw new Error(`Missing deployID?`);
        const oldDom = await createPod("test");

        const { dom } = await doBuild(<Group />, { deployID });
        await plugin.start(options);
        const obs = await plugin.observe(oldDom, dom);
        const actions = plugin.analyze(oldDom, dom, obs);
        should(actions.length).equal(1);
        should(actions[0].type).equal(ChangeType.delete);
        should(actions[0].detail).startWith("Deleting Pod");
        should(actions[0].changes).have.length(1);
        should(actions[0].changes[0].type).equal(ChangeType.delete);
        should(actions[0].changes[0].detail).startWith("Deleting Pod");
        should(actions[0].changes[0].element.componentName).equal("Resource");
        should(actions[0].changes[0].element.props.key).equal("test");

        await act(actions);

        await sleep(6); // Sleep longer than termination grace period
        const pods = await getAll("pods", { client, deployID });
        if (pods.length !== 0) {
            should(pods.length).equal(1);
            should(pods[0].metadata.deletionGracePeriod).not.Undefined();
        }

        await plugin.finish();
    });

    it("Should delete pod in alternate namespace", async () => {
        if (!deployID) throw new Error(`Missing deployID?`);
        const oldDom = await createPod("test", testNamespace);

        const { dom } = await doBuild(<Group />, { deployID });
        await plugin.start(options);
        const obs = await plugin.observe(oldDom, dom);
        const actions = plugin.analyze(oldDom, dom, obs);
        should(actions.length).equal(1);
        should(actions[0].type).equal(ChangeType.delete);
        should(actions[0].detail).startWith("Deleting Pod");
        should(actions[0].changes).have.length(1);
        should(actions[0].changes[0].type).equal(ChangeType.delete);
        should(actions[0].changes[0].detail).startWith("Deleting Pod");
        should(actions[0].changes[0].element.componentName).equal("Resource");
        should(actions[0].changes[0].element.props.key).equal("test");

        await act(actions);

        await sleep(6); // Sleep longer than termination grace period
        const pods = await getAll("pods", { client, deployID });
        if (pods.length !== 0) {
            should(pods.length).equal(1);
            should(pods[0].metadata.deletionGracePeriod).not.Undefined();
        }

        await plugin.finish();
    });

    it("Should not delete unmanaged pod", async () => {
        const manifest = {
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
                name: randomName("unmanaged-pod")
            },
            spec: {
                containers: [{
                    name: "sleep",
                    image: "alpine:latest",
                    command: ["sleep", "5s"]
                }],
                terminationGracePeriodSeconds: 0
            }
        };

        const result = await client.api.v1.namespaces("default").pods.post({ body: manifest });
        should(result.statusCode).equal(201);

        const { dom } = await doBuild(<Group />, { deployID });
        await plugin.start(options);
        const obs = await plugin.observe(null, dom);
        const actions = plugin.analyze(null, dom, obs);
        should(actions.length).equal(0);
        await plugin.finish();

        await client.api.v1.namespaces("default").pods(manifest.metadata.name).delete();
    });

    it("Should handle deleted pod", async () => {
        if (!deployID) throw new Error(`Missing deployID?`);
        const oldDom = await createPod("test");

        // Check that the pod was created
        const podName = resourceElementToName(oldDom, options.deployID);
        let pods = await getAll("pods", { client, deployID });
        should(pods).length(1);
        should(pods[0].metadata.name).equal(podName);

        const result = await client.api.v1.namespaces("default").pods(podName).delete();
        should(result.statusCode).equal(200);

        // No change in DOM
        const updateDom = createPodDom("test");

        const { dom } = await doBuild(updateDom, { deployID });

        await plugin.start(options);
        const obs = await plugin.observe(oldDom, dom);
        const actions = plugin.analyze(oldDom, dom, obs);
        should(actions).length(1);
        should(actions[0].type).equal(ChangeType.modify);
        should(actions[0].detail).startWith("Creating Pod");
        should(actions[0].changes).have.length(1);
        should(actions[0].changes[0].type).equal(ChangeType.modify);
        should(actions[0].changes[0].detail).startWith("Creating Pod");
        should(actions[0].changes[0].element.componentName).equal("Resource");
        should(actions[0].changes[0].element.props.key).equal("test");

        await act(actions);

        pods = await getAll("pods", { client, deployID });
        should(pods).length(1);
        should(pods[0].metadata.name).equal(podName);

        await plugin.finish();
    });
});
