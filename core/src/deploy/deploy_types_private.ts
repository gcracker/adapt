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

import {
    isObject,
    TaskObserver,
} from "@adpt/utils";
import { isFunction, isString } from "lodash";
import {
    AdaptMountedElement,
} from "../jsx";
import { Deployment } from "../server/deployment";
import { DeployOpID, DeployStepID } from "../server/deployment_data";
import {
    ActionChange,
    DeployedWhenMethod,
    DeployStatus,
    DeployStatusExt,
    ExecuteComplete,
    ExecuteOptions,
    GoalStatus,
    isDependsOn,
    RelationExt,
} from "./deploy_types";

export interface ExecutePassOptions extends Required<ExecuteOptions> {
    nodeStatus: StatusTracker;
    timeoutTime: number;
}

export interface WaitInfo {
    deployedWhen: (gs: GoalStatus) => ReturnType<DeployedWhenMethod>;
    description: string;

    actingFor?: ActionChange[];
    action?: () => void | Promise<void>;
    /**
     * True if there is an Action that affects this node in the current
     * execution plan.
     */
    activeAction?: boolean;
    dependsOn?: RelationExt;
    logAction?: boolean;
}

export function isWaitInfo(v: any): v is WaitInfo {
    return (
        isObject(v) &&
        isFunction(v.deployedWhen) &&
        isString(v.description) &&
        (v.actingFor === undefined || Array.isArray(v.actingFor)) &&
        (v.action === undefined || isFunction(v.action)) &&
        (v.dependsOn === undefined || isDependsOn(v.dependsOn))
    );
}

export interface EPNode {
    /**
     * For Element nodes, this contains all the Element's original children
     * and its successor.
     */
    children: Set<EPNode>;
    /** Actions do not have an Element directly associated with them. */
    element?: AdaptMountedElement;
    goalStatus: GoalStatus;
    waitInfo: WaitInfo;
}

export type EPObject = EPNode | AdaptMountedElement | WaitInfo;
export type EPNodeId = string;

export interface StatusTracker {
    readonly deployment: Deployment;
    readonly dryRun: boolean;
    readonly goalStatus: GoalStatus;
    readonly nodeStatus: Record<DeployStatus, number>;
    readonly deployOpID: DeployOpID;
    readonly primStatus: Record<DeployStatus, number>;
    readonly statMap: Map<EPNode, DeployStatusExt>;
    readonly taskMap: Map<EPNode, TaskObserver>;
    readonly stepID?: DeployStepID;
    get(n: EPNode): DeployStatusExt;
    set(n: EPNode, statExt: DeployStatusExt, err: Error | undefined,
        description?: string): Promise<boolean>;
    isFinal(n: EPNode): boolean;
    isActive(n: EPNode): boolean;
    output(n: EPNode, s: string): void;
    complete(stateChanged: boolean): Promise<ExecuteComplete>;
    debug(getId: (n: EPNode) => string): string;
}
