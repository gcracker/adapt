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

import {
    mapMap,
    MessageLogger,
    TaskState,
    UserError,
} from "@adpt/utils";
import * as fs from "fs-extra";
import * as ld from "lodash";
import * as path from "path";
import { inspect } from "util";
import { domDiff, DomDiff, domDiffElements, logElements } from "../dom_utils";
import { InternalError } from "../error";
import {
    AdaptElementOrNull,
    AdaptMountedElement,
    isFinalDomElement,
    isMountedElement,
} from "../jsx";
import { findPackageInfo } from "../packageinfo";
import { DeployOpID } from "../server";
import { Deployment } from "../server/deployment";
import { getAdaptContext } from "../ts";

import {
    ActComplete,
    Action,
    ActOptions,
    DeployOpStatus,
    EPPrimitiveDependencies,
    ExecutionPlan,
    GoalStatus,
    Plugin,
    PluginConfig,
    PluginInstances,
    PluginKey,
    PluginManager,
    PluginManagerStartOptions,
    PluginModule,
    PluginModules,
    PluginObservations,
    PluginRegistration,
} from "./deploy_types";
import { createExecutionPlan, execute } from "./execution_plan";

export function createPluginManager(modules: PluginModules): PluginManager {
    const config = createPluginConfig(modules);
    return new PluginManagerImpl(config);
}

/**
 * For testing only.
 */
export function isPluginManagerImpl(val: any): val is PluginManagerImpl {
    return val !== null && val instanceof PluginManagerImpl;
}

enum PluginManagerState {
    Initial = "Initial",
    Starting = "Starting",
    PreObserve = "PreObserve",
    Observing = "Observing",
    PreAnalyze = "PreAnalyze",
    Analyzing = "Analyzing",
    PreAct = "PreAct",
    Acting = "Acting",
    PreFinish = "PreFinish",
    Finishing = "Finishing"
}

function legalStateTransition(prev: PluginManagerState, next: PluginManagerState): boolean {
    switch (prev) {
        case PluginManagerState.Initial:
            return next === PluginManagerState.Starting;
        case PluginManagerState.Starting:
            return next === PluginManagerState.PreObserve;
        case PluginManagerState.PreObserve:
            return next === PluginManagerState.Observing;
        case PluginManagerState.Observing:
            return next === PluginManagerState.PreAnalyze;
        case PluginManagerState.PreAnalyze:
            return [
                PluginManagerState.Analyzing,
                PluginManagerState.Finishing,
            ].find((v) => v === next) !== undefined;
        case PluginManagerState.Analyzing:
            return next === PluginManagerState.PreAct;
        case PluginManagerState.PreAct:
            return [
                PluginManagerState.Finishing, // finish without acting
                PluginManagerState.Acting
            ].find((v) => v === next) !== undefined;
        case PluginManagerState.Acting:
            return [
                PluginManagerState.PreAnalyze, //  dryRun
                PluginManagerState.PreFinish   // !dryRun
            ].find((v) => v === next) !== undefined;
        case PluginManagerState.PreFinish:
            return next === PluginManagerState.Finishing;
        case PluginManagerState.Finishing:
            return next === PluginManagerState.Initial;
    }
}

export function checkPrimitiveActions(diff: DomDiff, actions: Action[]) {
    const hasPlugin = (el: AdaptMountedElement) => !el.componentType.noPlugin;
    const changes = ld.flatten(actions.map((a) => a.changes));
    const done = new Set<AdaptMountedElement>();

    // The set of elements that should be claimed by plugins (i.e. referenced
    // in a change) is all elements in the new DOM (added+commonNew) and
    // all elements deleted from the old DOM, then filtered by the noPlugin
    // flag.
    const newEls = new Set([...diff.added, ...diff.commonNew].filter(hasPlugin));
    const deleted = new Set([...diff.deleted].filter(hasPlugin));

    changes.forEach((c) => {
        const el = c.element;
        if (!isMountedElement(el)) {
            throw new UserError(`A plugin returned an Action with an ActionChange ` +
                `where the 'element' property is not a valid and mounted Element. ` +
                `(element=${inspect(el)})`);
        }
        if (!hasPlugin(el)) return;

        // Only check each el once to avoid triggering warning if el is in
        // more than one change.
        if (done.has(el)) return;
        done.add(el);

        if (!newEls.delete(el) && !deleted.delete(el)) {
            logElements(`WARNING: Element was specified as affected by a ` +
                `plugin action but was not found in old or new DOM as expected:\n` +
                // tslint:disable-next-line: no-console
                `(change: ${c.detail}): `, [el], console.log);
        }
    });

    if (newEls.size > 0) {
        logElements(`WARNING: The following new or updated elements were ` +
            `not claimed by any deployment plugin and will probably not be ` +
            // tslint:disable-next-line: no-console
            `correctly deployed:\n`, [...newEls], console.log);
    }
    if (deleted.size > 0) {
        logElements(`WARNING: The following deleted elements were ` +
            `not claimed by any deployment plugin and will probably not be ` +
            // tslint:disable-next-line: no-console
            `correctly deleted:\n`, [...deleted], console.log);
    }
}

interface AnyObservation {
    [name: string]: any;
}

const defaultStartOptions = {
    prevDependencies: {},
};

const defaultActOptions = {
    dryRun: false,
    ignoreDeleteErrors: false,
    processStateUpdates: () => Promise.resolve({ stateChanged: false }),
};

class PluginManagerImpl implements PluginManager {
    // Initialized during construction
    modules: PluginModules;
    parallelActions: Action[] = [];
    plugins: PluginInstances;
    state: PluginManagerState;

    // Initialized during `start`
    deployment_?: Deployment;
    deployOpID_?: DeployOpID;
    goalStatus_?: GoalStatus;
    logger_?: MessageLogger;
    newDom_?: AdaptElementOrNull;
    newMountedElements_?: AdaptMountedElement[];
    observations: AnyObservation;
    prevDependencies_?: EPPrimitiveDependencies;
    prevDom_?: AdaptElementOrNull;
    prevMountedElements_?: AdaptMountedElement[];

    // Created during `analyze`
    plan_?: ExecutionPlan;

    constructor(config: PluginConfig) {
        this.plugins = new Map(config.plugins);
        this.modules = new Map(config.modules);
        this.state = PluginManagerState.Initial;
    }

    transitionTo(next: PluginManagerState) {
        if (!legalStateTransition(this.state, next)) {
            throw new InternalError(`Illegal call to Plugin Manager, attempting to go from ${this.state} to ${next}`);
        }
        this.state = next;
    }

    async start(opts: PluginManagerStartOptions) {
        this.transitionTo(PluginManagerState.Starting);
        const options = { ...defaultStartOptions, ...opts };

        this.deployment_ = options.deployment;
        this.deployOpID_ = options.deployOpID;
        this.goalStatus_ = options.newDom === null ? GoalStatus.Destroyed : GoalStatus.Deployed;
        this.logger_ = options.logger;
        this.newDom_ = options.newDom;
        this.newMountedElements_ = options.newMountedElements;
        this.observations = {};
        this.prevDependencies_ = options.prevDependencies;
        this.prevDom_ = options.prevDom;
        this.prevMountedElements_ = options.prevMountedElements;

        const loptions = {
            deployID: options.deployment.deployID,
            log: options.logger.info, //FIXME(manishv) have a per-plugin log here
            logger: options.logger,
        };
        const waitingFor = mapMap(this.plugins, async (key, plugin) => {
            const pMod = this.modules.get(key);
            if (!pMod) throw new InternalError(`no module found for ${key}`);
            const dataDir = pluginDataDir(options.dataDir, pMod);
            await fs.ensureDir(dataDir);
            return plugin.start({
                dataDir,
                ...loptions
            });
        });

        await Promise.all(waitingFor);
        this.transitionTo(PluginManagerState.PreObserve);
    }

    async observe() {
        this.transitionTo(PluginManagerState.Observing);
        const dom = this.newDom;
        const prevDom = this.prevDom;
        if (dom === undefined || prevDom === undefined) {
            throw new InternalError("Must call start before observe");
        }
        const observationsP = mapMap(
            this.plugins,
            async (key, plugin) => ({ pluginKey: key, obs: await plugin.observe(prevDom, dom) }));
        const observations = await Promise.all(observationsP);
        const ret: PluginObservations = {};
        for (const { pluginKey: key, obs } of observations) {
            this.observations[key] = JSON.stringify(obs);
            ret[key] = obs;
        }

        this.transitionTo(PluginManagerState.PreAnalyze);
        return ret;
    }

    analyze() {
        this.transitionTo(PluginManagerState.Analyzing);
        const dom = this.newDom;
        const prevDom = this.prevDom;
        if (dom === undefined || prevDom === undefined) {
            throw new InternalError("Must call start before analyze");
        }

        this.parallelActions = [];

        for (const [name, plugin] of this.plugins) {
            const obs = JSON.parse(this.observations[name]);
            const actions = plugin.analyze(prevDom, dom, obs);
            this.addActions(actions, plugin);
        }

        if (dom && !isFinalDomElement(dom)) {
            throw new InternalError(`dom is not MountedPrimitive`);
        }
        if (prevDom && !isMountedElement(prevDom)) {
            throw new InternalError(`prevDom is not Mounted`);
        }
        const diff = domDiff(prevDom, dom);
        checkPrimitiveActions(diff, this.actions);

        this.plan_ = createExecutionPlan({
            actions: this.actions,
            dependencies: this.prevDependencies,
            deployment: this.deployment,
            deployOpID: this.deployOpID,
            diff: domDiffElements(this.prevMountedElements, this.newMountedElements),
            newDom: dom,
            goalStatus: this.goalStatus,
        });
        this.plan.check();

        this.transitionTo(PluginManagerState.PreAct);
        return {
            actions: this.actions,
            dependencies: this.plan.primitiveDependencies,
        };
    }

    addActions(actions: Action[], plugin: Plugin) {
        this.parallelActions = this.parallelActions.concat(actions);
    }

    async act(options: ActOptions): Promise<ActComplete> {
        const opts = { ...defaultActOptions, ...options };
        // tslint:disable-next-line: no-this-assignment
        const { goalStatus, logger, plan } = this;

        if (opts.taskObserver.state !== TaskState.Started) {
            throw new InternalError(
                `PluginManager: A new TaskObserver must be provided for additional calls to act()`);
        }

        this.transitionTo(PluginManagerState.Acting);

        const { deploymentStatus, stateChanged } = await execute({
            ...opts,
            logger,
            plan,
        });
        if (deploymentStatus === DeployOpStatus.Failed) {
            throw new UserError(`Errors encountered during plugin action phase`);
        }
        const deployComplete = deploymentStatus === goalStatus;
        if (!deployComplete && deploymentStatus !== DeployOpStatus.StateChanged) {
            throw new InternalError(`Unexpected DeployOpStatus (${deploymentStatus}) from execute`);
        }

        // In the case of a dry run, the ExecutionPlan has been used, so
        // analyze must be called again to create a new one.
        if (opts.dryRun) this.transitionTo(PluginManagerState.PreAnalyze);
        else this.transitionTo(PluginManagerState.PreFinish);

        return {
            deployComplete,
            stateChanged,
        };
    }

    async finish() {
        this.transitionTo(PluginManagerState.Finishing);
        const waitingFor = mapMap(this.plugins, (_, plugin) => plugin.finish());
        await Promise.all(waitingFor);
        delete this.deployment_;
        delete this.deployOpID_;
        delete this.goalStatus_;
        delete this.logger_;
        delete this.newDom_;
        delete this.newMountedElements_;
        this.observations = {};
        delete this.prevDependencies_;
        delete this.prevDom_;
        delete this.prevMountedElements_;
        delete this.plan_;
        this.transitionTo(PluginManagerState.Initial);
    }

    get deployment(): Deployment {
        if (this.deployment_ === undefined) throw new InternalError(`Must call start before accessing deployment`);
        return this.deployment_;
    }

    get deployOpID(): DeployOpID {
        if (this.deployOpID_ === undefined) throw new InternalError(`Must call start before accessing deployOpID`);
        return this.deployOpID_;
    }

    get goalStatus(): GoalStatus {
        if (this.goalStatus_ === undefined) throw new InternalError(`Must call start before accessing goalStatus`);
        return this.goalStatus_;
    }

    get logger(): MessageLogger {
        if (this.logger_ === undefined) {
            throw new InternalError(`Must call start before accessing logger`);
        }
        return this.logger_;
    }

    get newDom(): AdaptElementOrNull {
        if (this.newDom_ === undefined) {
            throw new InternalError(`Must call start before accessing newDom`);
        }
        return this.newDom_;
    }

    get newMountedElements(): AdaptMountedElement[] {
        if (this.newMountedElements_ === undefined) {
            throw new InternalError(`Must call start before accessing newMountedElements`);
        }
        return this.newMountedElements_;
    }

    get plan(): ExecutionPlan {
        if (this.plan_ === undefined) throw new InternalError(`Must call analyze before accessing plan`);
        return this.plan_;
    }

    get prevDependencies(): EPPrimitiveDependencies {
        if (this.prevDependencies_ === undefined) {
            throw new InternalError(`Must call start before accessing prevDependencies`);
        }
        return this.prevDependencies_;
    }

    get prevDom(): AdaptElementOrNull {
        if (this.prevDom_ === undefined) {
            throw new InternalError(`Must call start before accessing prevDom`);
        }
        return this.prevDom_;
    }

    get prevMountedElements(): AdaptMountedElement[] {
        if (this.prevMountedElements_ === undefined) {
            throw new InternalError(`Must call start before accessing prevMountedElements`);
        }
        return this.prevMountedElements_;
    }

    private get actions(): Action[] {
        return this.parallelActions;
    }
}

function pluginKey(pMod: PluginModule): PluginKey {
    return `${pMod.name} [${pMod.packageName}@${pMod.version}]`;
}

function pluginDataDir(dataDirRoot: string, pMod: PluginModule): string {
    return path.join(dataDirRoot, `${pMod.packageName}@${pMod.version}`, pMod.name);
}

export function registerPlugin(plugin: PluginRegistration) {
    const modules = getAdaptContext().pluginModules;
    const pInfo = findPackageInfo(path.dirname(plugin.module.filename));
    const mod = {
        ...plugin,
        packageName: pInfo.name,
        version: pInfo.version,
    };
    const key = pluginKey(mod);

    const existing = modules.get(key);
    if (existing !== undefined) {
        // Ignore if they're registering the exact same info
        if (existing.create === plugin.create) return;
        throw new Error(
            `Attempt to register two plugins with the same name from the ` +
            `same package: ${key}`);
    }
    modules.set(key, mod);
}

export function createPluginConfig(modules: PluginModules): PluginConfig {
    if (modules.size === 0) throw new Error(`No plugins registered`);
    const plugins: PluginInstances = new Map<PluginKey, Plugin>();

    for (const [key, mod] of modules) {
        plugins.set(key, mod.create());
    }
    return { modules, plugins };
}
