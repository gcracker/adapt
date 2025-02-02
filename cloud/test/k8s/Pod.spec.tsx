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
    AdaptMountedElement,
    AdaptMountedPrimitiveElement,
    BuiltinProps,
    ChangeType,
    childrenToArray,
    DomError,
    Group,
    handle,
    isElement,
    PluginOptions,
    rule,
    Style,
    Waiting,
} from "@adpt/core";
import * as ld from "lodash";
import should from "should";

import { createMockLogger, k8sutils, MockLogger } from "@adpt/testutils";
import { sleep } from "@adpt/utils";
import * as abs from "../../src";
import {
    ActionPlugin,
    createActionPlugin
} from "../../src/action";
import {
    ClusterInfo,
    ConfigMap,
    Container,
    K8sContainer,
    Kubeconfig,
    Pod,
    podResourceInfo,
    resourceElementToName,
    ResourcePod,
    Secret,
    ServiceAccount
} from "../../src/k8s";
import { labelKey } from "../../src/k8s/manifest_support";
import { mkInstance } from "../run_minikube";
import { act, checkNoActions, doBuild, randomName } from "../testlib";
import { forceK8sObserverSchemaLoad, K8sTestStatusType } from "./testlib";

const { deleteAll, getAll } = k8sutils;

// tslint:disable-next-line: no-object-literal-type-assertion
const dummyConfig = {} as ClusterInfo;

describe("k8s Pod Component Tests", () => {
    it("Should Instantiate Pod", () => {
        const pod =
            <Pod key="test" config={dummyConfig}>
                <K8sContainer name="onlyContainer" image="node:latest" />
            </Pod>;

        should(pod).not.Undefined();
    });

    it("Should enforce unique container names", async () => {
        const pod =
            <Pod key="test" config={dummyConfig}>
                <K8sContainer name="container" image="node:latest" />
                <K8sContainer name="dupContainer" image="node:latest" />
                <K8sContainer name="dupContainer" image="node:latest" />
            </Pod>;

        should(pod).not.Undefined();
        const { contents: dom } = await Adapt.build(pod, null);
        if (dom == null) {
            should(dom).not.Null();
            return;
        }

        const kids = childrenToArray(dom.props.children);
        const err = ld.find(kids, (child) => {
            if (!isElement(child)) return false;
            if (child.componentType === DomError) return true;
            return false;
        });

        should(err).not.Undefined();
        if (!isElement(err)) {
            should(isElement(err)).True();
            return;
        }

        should(err.props.children).match(/dupContainer/);
    });

    it("Should translate from abstract to k8s", async () => {
        const absDom =
            <abs.Compute>
                <abs.Container name="one" dockerHost="" image="alpine" />
                <abs.Container name="two" dockerHost="" image="alpine" />
            </abs.Compute>;
        const style =
            <Style>
                {abs.Container} {rule<abs.ContainerProps>(({ handle: hand, ...props }) => (
                    <Container {...props} />
                ))}
                {abs.Compute} {rule<abs.ComputeProps>((props) => (
                    <Pod config={dummyConfig}>
                        {props.children}
                    </Pod>
                ))}
            </Style>;
        const result = await Adapt.build(absDom, style);
        const dom = result.contents;
        if (dom == null) {
            should(dom).not.be.Null();
            return;
        }
        should(result.messages).have.length(0);

        const domXml = Adapt.serializeDom(dom);
        const expected =
            `<Adapt>
  <Resource kind="Pod">
    <__props__>
      <prop name="config">{}</prop>
      <prop name="isTemplate">false</prop>
      <prop name="key">"Compute-Pod"</prop>
      <prop name="metadata">{}</prop>
      <prop name="spec">{
        dnsPolicy: "ClusterFirst",
        enableServiceLinks: true,
        hostIPC: false,
        hostPID: false,
        restartPolicy: "Always",
        securityContext: {},
        shareProcessNamespace: false,
        terminationGracePeriodSeconds: 30,
        containers: [
          {
            imagePullPolicy: "IfNotPresent",
            name: "one",
            image: "alpine",
          },
          {
            imagePullPolicy: "IfNotPresent",
            name: "two",
            image: "alpine",
          },
        ],
        volumes: undefined,
      }</prop>
    </__props__>
  </Resource>
</Adapt>
`;
        should(domXml).eql(expected);
    });

    it("Should translate volumes correctly", async () => {
        const secHandle = handle();
        const mapHandle = handle();
        const podHandle = handle();
        const items = [ { key: "foo", path: "foo"} ];
        const orig = <Group>
            <Secret handle={secHandle} config={dummyConfig} stringData={{ foo: "bar" }} />
            <ConfigMap handle={mapHandle} config={dummyConfig} data={{ foo: "bar" }} />
            <Pod
              key="test"
              handle={podHandle}
              config={dummyConfig}
              volumes={[
                  { name: "s0", secret: { secretName: "foo", items} },
                  { name: "c1", configMap: { name: "foo", items } },
                  { name: "s2", secret: { secretName: secHandle, items }},
                  { name: "c3", configMap: { name: mapHandle, items }}
              ]}
            >
                <K8sContainer name="container" image="node:latest" />
            </Pod>
        </Group>;

        should(orig).not.Undefined();
        const deployID = "foo";
        const { contents: dom } = await Adapt.build(orig, null, { deployID });
        if (dom == null) throw should(dom).not.Null();

        const podTarget = podHandle.target;
        const secTarget = secHandle.target;
        const mapTarget = mapHandle.target;
        if (podTarget == undefined) throw should(podTarget).not.Undefined();
        if (secTarget == undefined) throw should(secTarget).not.Undefined();
        if (mapTarget == undefined) throw should(mapTarget).not.Undefined();

        const props = podTarget.props as ResourcePod & BuiltinProps;
        should(props.kind).equal("Pod");
        const podSpec = props.spec;
        should(podSpec).not.Undefined();

        const volumes = podSpec.volumes;
        if (volumes === undefined) throw should(volumes).not.Undefined();
        should(volumes).length(4);
        should(volumes.map((v) => v.name)).eql(["s0", "c1", "s2", "c3"]);

        const v0secret = volumes[0].secret;
        if (v0secret === undefined) throw should(v0secret).not.Undefined();
        should(v0secret.secretName).equal("foo");
        should(v0secret.items).eql(items);

        const v1map = volumes[1].configMap;
        if (v1map === undefined) throw should(v1map).not.Undefined();
        should(v1map.name).equal("foo");
        should(v1map.items).eql(items);

        const v2secret = volumes[2].secret;
        if (v2secret === undefined) throw should(v2secret).not.Undefined();
        should(v2secret.secretName).equal(resourceElementToName(secTarget, deployID));
        should(v2secret.items).eql(items);

        const v3map = volumes[3].configMap;
        if (v3map === undefined) throw should(v3map).not.Undefined();
        should(v3map.name).equal(resourceElementToName(mapTarget, deployID));
        should(v3map.items).eql(items);
    });

    it("Should translate volumeMounts correctly", async () => {
        const podHandle = handle();
        const orig = <Pod
              key="test"
              handle={podHandle}
              config={dummyConfig}
              volumes={[
                  { name: "s0", secret: { secretName: "foo" } },
              ]}
            >
                <K8sContainer
                    name="container"
                    image="node:latest"
                    volumeMounts={[
                        { name: "s0", mountPath: "/secret0" }
                    ]}
                />
            </Pod>;

        should(orig).not.Undefined();
        const deployID = "foo";
        const { contents: dom } = await Adapt.build(orig, null, { deployID });
        if (dom == null) throw should(dom).not.Null();

        const podTarget = podHandle.target;
        if (podTarget == undefined) throw should(podTarget).not.Undefined();

        const props = podTarget.props as ResourcePod & BuiltinProps;
        should(props.kind).equal("Pod");
        const podSpec = props.spec;
        should(podSpec).not.Undefined();

        const containers = podSpec.containers;
        should(containers).length(1);

        const volumeMounts = containers[0].volumeMounts;
        if (volumeMounts === undefined) throw should(volumeMounts).not.Undefined();
        should(volumeMounts).length(1);
        should(volumeMounts[0].name).equal("s0");
        should(volumeMounts[0].mountPath).equal("/secret0");
    });

    it("Should resolve serviceAccount correctly", async () => {
        const podHandle = handle();
        const serviceAccountHandle = handle();
        const orig = <Group>
            <ServiceAccount handle={serviceAccountHandle} config={dummyConfig} />
            <Pod
              key="test"
              handle={podHandle}
              config={dummyConfig}
              serviceAccountName={serviceAccountHandle}
            >
                <K8sContainer
                    name="container"
                    image="node:latest"
                />
            </Pod>
        </Group>;

        should(orig).not.Undefined();
        const deployID = "foo";
        const { contents: dom } = await Adapt.build(orig, null, { deployID });
        if (dom == null) throw should(dom).not.Null();

        const podTarget = podHandle.target;
        if (podTarget == undefined) throw should(podTarget).not.Undefined();
        const serviceAccountTarget = serviceAccountHandle.target;
        if (serviceAccountTarget == undefined) throw should(serviceAccountTarget).not.Undefined();

        const props = podTarget.props as ResourcePod & BuiltinProps;
        should(props.kind).equal("Pod");
        const podSpec = props.spec;
        should(podSpec).not.Undefined();
        should(podSpec.serviceAccountName).equal(resourceElementToName(serviceAccountTarget, deployID));
    });
});

async function waitForDeployed(mountedOrig: AdaptMountedElement, dom: AdaptMountedElement, deployID: string) {
    let deployed: boolean | Waiting = false;
    do {
        const status = await mountedOrig.status<K8sTestStatusType>();
        should(status.kind).equal("Pod");
        should(status.metadata.name).equal(resourceElementToName(dom, deployID));
        should(status.metadata.annotations).containEql({ [labelKey("name")]: dom.id });
        deployed = podResourceInfo.deployedWhen(status);
        if (deployed !== true) await sleep(1000);
        else return status;
    } while (1);
}

describe("k8s Pod Operation Tests", function () {
    this.timeout(60 * 1000);

    let plugin: ActionPlugin;
    let logger: MockLogger;
    let options: PluginOptions;
    let kubeClusterInfo: ClusterInfo;
    let client: k8sutils.KubeClient;
    let deployID: string | undefined;

    before(async function () {
        this.timeout(mkInstance.setupTimeoutMs);
        this.slow(20 * 1000);
        kubeClusterInfo = { kubeconfig: await mkInstance.kubeconfig as Kubeconfig };
        client = await mkInstance.client;
        forceK8sObserverSchemaLoad();
    });

    beforeEach(async () => {
        plugin = createActionPlugin();
        logger = createMockLogger();
        deployID = randomName("cloud-pod-op");
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

    async function createPod(name: string): Promise<AdaptMountedPrimitiveElement | null> {
        const pod =
            <Pod key={name} config={kubeClusterInfo} terminationGracePeriodSeconds={0}>
                <K8sContainer name="container" image="alpine:3.8" command={["sleep", "3s"]} />
            </Pod>;

        const { mountedOrig, dom } = await doBuild(pod, { deployID });

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

        if (!deployID) throw new Error(`Missing deployID?`);

        await act(actions);
        await waitForDeployed(mountedOrig, dom, deployID);

        const pods = await getAll("pods", { client, deployID });
        should(pods).length(1);
        should(pods[0].metadata.name)
            .equal(resourceElementToName(dom, deployID));

        if (mountedOrig === null) throw should(mountedOrig).not.Null();
        const status = await mountedOrig.status<K8sTestStatusType>();
        should(status.kind).equal("Pod");
        should(status.metadata.name).equal(resourceElementToName(dom, options.deployID));
        should(status.metadata.annotations).containEql({ [labelKey("name")]: dom.id });

        await plugin.finish();
        return dom;
    }

    it("Should create pod", async () => {
        await createPod("test");
    });

    it("Should modify pod", async () => {
        const oldDom = await createPod("test");

        //5s sleep diff to cause modify vs. 3s sleep in createPod
        const command = ["sleep", "5s"];
        const pod =
            <Pod key="test" config={kubeClusterInfo} terminationGracePeriodSeconds={0}>
                <K8sContainer name="container" image="alpine:3.8" command={command} />
            </Pod>;

        const { dom } = await doBuild(pod, { deployID });

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

        if (!deployID) throw new Error(`Missing deployID?`);

        await act(actions);

        const pods = await getAll("pods", { client, deployID });
        should(pods).length(1);
        should(pods[0].metadata.name)
            .equal(resourceElementToName(dom, deployID));
        should(pods[0].spec.containers).length(1);
        should(pods[0].spec.containers[0].command).eql(command);

        await plugin.finish();
    });

    it("Should leave pod alone", async () => {
        const oldDom = await createPod("test");

        //No diff
        const command = ["sleep", "3s"];
        const pod =
            <Pod key="test" config={kubeClusterInfo} terminationGracePeriodSeconds={0}>
                <K8sContainer name="container" image="alpine:3.8" command={command} />
            </Pod>;

        const { dom } = await doBuild(pod, { deployID });

        await plugin.start(options);
        const obs = await plugin.observe(oldDom, dom);
        const actions = plugin.analyze(oldDom, dom, obs);
        checkNoActions(actions, dom);
        await plugin.finish();
    });

    it("Should delete pod", async () => {
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

        if (!deployID) throw new Error(`Missing deployID?`);

        await act(actions);

        await sleep(6); // Sleep longer than termination grace period
        const pods = await getAll("pods", { client, deployID });
        if (pods.length !== 0) {
            should(pods.length).equal(1);
            should(pods[0].metadata.deletionGracePeriod).not.Undefined();
        }

        await plugin.finish();
    });

});
