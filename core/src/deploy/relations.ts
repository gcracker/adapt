import { toArray } from "@adpt/utils";
import { isFunction } from "lodash";
import {
    Dependency,
    DeployHelpers,
    IsDeployedFunc,
    Relation,
    RelationExt,
    Waiting,
} from "./deploy_types";
import {
    depName,
    nDepends,
    relationIsReadyStatus,
    toRelation,
} from "./relation_utils";

export const waiting = (status: string, related?: Waiting[]): Waiting => {
    const ret: Waiting = { done: false, status };
    if (related) ret.related = related;
    return ret;
};

// tslint:disable: variable-name

export const True = (): Relation => ({
    description: "True",
    ready: () => true,
});

export const False = (): Relation => ({
    description: "False",
    ready: () => waiting("False is never ready"),
});

export const Identity = (a0: Relation): Relation => ({
    description: "",
    ready: (args) => relationIsReadyStatus(args[0]),
    relatesTo: [a0],
});

export const Not = (a0: Relation): Relation => ({
    description: "Not",
    ready: (args) => {
        const stat = relationIsReadyStatus(args[0]);
        if (stat !== true) return true;
        return waiting("Not ready because child Relation is ready");
    },
    relatesTo: [a0],
});

export const And = (...relatesTo: Relation[]): Relation => ({
    description: "And",
    ready: (rList) => {
        const status = relationIsReadyStatus(rList);
        if (status === true) return true;
        const notReady = toArray(status);
        return waiting(`Waiting for ${nDepends(notReady.length)}`, toArray(notReady));
    },
    relatesTo,
});

export const Or = (...relatesTo: Relation[]): Relation => ({
    description: "Or",
    ready: (rList) => {
        const status = relationIsReadyStatus(rList);
        if (status === true) return true;
        const notReady = toArray(status);
        if (notReady.length < rList.length) return true;
        return waiting(`Waiting for any of ${nDepends(notReady.length)}`,
            toArray(notReady));
    },
    relatesTo,
});

export const Edge =
    (a0: Dependency, a1: Dependency, isDeployed: IsDeployedFunc): RelationExt => ({
    description: "Edge",
    ready: () => {
        if (isDeployed(a1)) return true;
        return waiting(`Waiting for dependency ${depName(a1)}`);
    },
    inverse: () => Edge(a1, a0, isDeployed),
    toString: (indent = "") => `${indent}Edge( ${depName(a0)}, ${depName(a1)} )`,
    toDependencies: () => [ a1 ],
});

export type BoolVal = boolean | (() => boolean);

export const Value = (v: BoolVal, description = "Value"): Relation => ({
    description,
    ready: () => {
        if (isFunction(v) ? v() : v) return true;
        return waiting(`Waiting for ${description}`);
    },
    toString: (indent = ""): string => {
        return `${indent}${description}(${typeof v === "boolean" ? v : "<function>"})`;
    }
});

export function AllOf(h: DeployHelpers, deps: Dependency[]): Relation {
    return {
        description: "all of",
        relatesTo: deps.map((d) => toRelation(h, d)),
        ready: (rels) => relationIsReadyStatus(And(...rels)),
    };
}

export function Only(h: DeployHelpers, dep: Dependency): Relation {
    return {
        description: "only",
        relatesTo: [ toRelation(h, dep) ],
        ready: (rels) => relationIsReadyStatus(rels[0]),
    };
}

export function AnyOf(h: DeployHelpers, deps: Dependency[]): Relation {
    return {
        description: "any of",
        relatesTo: deps.map((d) => toRelation(h, d)),
        ready: (rels) => relationIsReadyStatus(Or(...rels)),
    };
}

export function None(): Relation {
    return {
        description: "none",
        ready: () => true,
    };
}