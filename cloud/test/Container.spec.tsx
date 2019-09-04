/*
 * Copyright 2018-2019 Unbounded Systems, LLC
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
    Action,
    AdaptElement,
    AdaptMountedElement,
    build,
    ChangeType,
    createStateStore,
    Group,
    rule,
    Style,
} from "@adpt/core";
import {
    createMockLogger,
    dockerutils,
    mochaTmpdir,
} from "@adpt/testutils";
import Docker = require("dockerode");
import fs from "fs-extra";
import path from "path";
import should from "should";

import {
    AnsibleDockerHost,
    ansibleHostLocal,
    Container as AContainer,
    createAnsiblePlugin
} from "../src/ansible";
import {
    Container,
    ContainerProps,
    ContainerStatus,
} from "../src/Container";
import {
    Environment,
    lookupEnvVar,
    renameEnvVars,
    updateEnvVars
} from "../src/env";
import { act, randomName } from "./testlib";

const { deleteContainer } = dockerutils;

describe("Container component", () => {
    const docker = new Docker({ socketPath: "/var/run/docker.sock" });
    let name: string;

    mochaTmpdir.all("adapt-test-Container");

    beforeEach(() => {
        name = randomName("adapt-cloud-test");
    });

    afterEach(async () => {
        await deleteContainer(docker, name);
    });

    async function runPlugin(dom: AdaptElement, checkActions: (actions: Action[]) => void) {
        const dataDir = path.join(process.cwd(), "pluginData");
        const plugin = createAnsiblePlugin();
        const logger = createMockLogger();
        const options = {
            deployID: "abc123",
            log: logger.info,
            logger,
            dataDir,
        };

        await fs.ensureDir(dataDir);
        await plugin.start(options);
        const obs = await plugin.observe(null, dom);
        const actions = plugin.analyze(null, dom, obs);
        await act(actions);
        checkActions(actions);
        await plugin.finish();
    }

    async function getContainerStatus(orig: AdaptMountedElement): Promise<ContainerStatus> {
        const status = await orig.status<any>();
        should(status).be.type("object");
        should(status.childStatus).have.length(2);
        const ctrStatus: ContainerStatus = status.childStatus[0];
        return ctrStatus;
    }

    it("Should build with local style and have status", async function () {
        this.timeout(3 * 60 * 1000);
        this.slow(1 * 60 * 1000);
        const root =
            <Group>
                <Container
                    dockerHost="file:///var/run/docker.sock"
                    name={name}
                    image="busybox:latest"
                    command="sleep 100000"
                    autoRemove={true}
                    stopSignal="SIGKILL"
                />
                <AnsibleDockerHost ansibleHost={ansibleHostLocal} />
            </Group>;
        const style =
            <Style>
                {Container} {rule<ContainerProps>(({ handle, ...props }) => <AContainer {...props} />)}
            </Style>;
        const stateStore = createStateStore();
        const { mountedOrig, contents: dom } = await build(root, style, { stateStore });

        if (mountedOrig == null) throw should(mountedOrig).not.be.Null();
        if (dom == null) throw should(dom).not.be.Null();

        let ctrStatus = await getContainerStatus(mountedOrig);
        should(ctrStatus).eql({ noStatus: `No such container: ${name}` });

        await runPlugin(dom, (actions) => {
            should(actions.length).equal(2);

            should(actions[0].detail).equal("Executing Playbook");
            should(actions[0].changes).have.length(1);
            should(actions[0].changes[0].type).equal(ChangeType.create);
            should(actions[0].changes[0].detail).equal("Executing Playbook");
            should(actions[0].changes[0].element.componentName).equal("AnsiblePlaybook");

            should(actions[1].detail).equal("Executing Playbook");
            should(actions[1].changes).have.length(3);
            should(actions[1].changes[0].type).equal(ChangeType.create);
            should(actions[1].changes[0].detail).equal("Executing Playbook");
            should(actions[1].changes[0].element.componentName).equal("AnsibleImplicitPlaybook");
            should(actions[1].changes[1].type).equal(ChangeType.create);
            should(actions[1].changes[1].detail).equal("Executing Playbook");
            should(actions[1].changes[1].element.componentName).equal("AnsibleRole");
            should(actions[1].changes[2].type).equal(ChangeType.create);
            should(actions[1].changes[2].detail).equal("Executing Playbook");
            should(actions[1].changes[2].element.componentName).equal("AnsibleRole");
        });

        ctrStatus = await getContainerStatus(mountedOrig);
        should(ctrStatus).be.type("object");
        should(ctrStatus.Name).equal("/" + name);
        should(ctrStatus.Path).equal("sleep");
        should(ctrStatus.Args).eql(["100000"]);
        should(ctrStatus.State.Status).equal("running");
    });
});

describe("lookupEnvVar Tests", () => {
    it("should lookup in SimpleEnv style Environment object", () => {
        const env = {
            FOO: "fooval",
            BAR: "barval"
        };

        should(lookupEnvVar(env, "FOO")).equal("fooval");
        should(lookupEnvVar(env, "BAR")).equal("barval");
        should(lookupEnvVar(env, "BAZ")).Undefined();
    });

    it("should lookup in an EnvPair[] style Environment object", () => {
        const env = [
            { name: "FOO", value: "fooval" },
            { name: "BAR", value: "barval" }
        ];

        should(lookupEnvVar(env, "FOO")).equal("fooval");
        should(lookupEnvVar(env, "BAR")).equal("barval");
        should(lookupEnvVar(env, "BAZ")).Undefined();
    });
});

describe("updateEnvVars Tests", () => {
    function upd(name: string, value: string) {
        switch (name) {
            case "FOO": return { name: "NEW_FOO", value: "newfooval" };
            case "BAR": return { name: "NEW_BAR", value };
            case "BAZ": return { name, value: "newbazval" };
            case "REMOVE": return undefined;
            default: return { name, value };
        }
    }

    it("should update names and values in SimpleEnv style Environment object", () => {
        const orig: Environment = {
            FOO: "fooval",
            BAR: "barval",
            BAZ: "bazval",
            REMOVE: "oldval",
            NOTOUCH: "origval"
        };

        const xformed = updateEnvVars(orig, upd);

        should(xformed).eql({
            NEW_FOO: "newfooval",
            NEW_BAR: "barval",
            BAZ: "newbazval",
            NOTOUCH: "origval"
        });
    });

    it("should update names and values in EnvPair[] style Environment object", () => {
        const orig: Environment = [
            { name: "FOO", value: "fooval" },
            { name: "BAR", value: "barval" },
            { name: "BAZ", value: "bazval" },
            { name: "REMOVE", value: "oldval" },
            { name: "NOTOUCH", value: "origval" }
        ];

        const xformed = updateEnvVars(orig, upd);

        should(xformed).eql([
            { name: "NEW_FOO", value: "newfooval" },
            { name: "NEW_BAR", value: "barval" },
            { name: "BAZ", value: "newbazval" },
            { name: "NOTOUCH", value: "origval" }
        ]);
    });
});

describe("renameEnvVars Tests", () => {
    const mapping = {
        BAR: "NEW_BAR",
        BAZ: "NEW_BAZ"
    };

    it("should rename SimpleEnv style Environment object", () => {
        const orig: Environment = {
            FOO: "fooval",
            BAR: "barval",
            BAZ: "bazval"
        };

        const xformed = renameEnvVars(orig, mapping);

        should(xformed).eql({
            FOO: "fooval",
            NEW_BAR: "barval",
            NEW_BAZ: "bazval"
        });
    });

    it("should rename EnvPair[] style Environment objects", () => {
        const orig: Environment = [
            { name: "FOO", value: "fooval" },
            { name: "BAR", value: "barval" },
            { name: "BAZ", value: "bazval" }
        ];

        const xformed = renameEnvVars(orig, mapping);

        should(xformed).eql([
            { name: "FOO", value: "fooval" },
            { name: "NEW_BAR", value: "barval" },
            { name: "NEW_BAZ", value: "bazval" }
        ]);
    });
});
