import { repoRootDir, yarn } from "@usys/utils";
import * as fs from "fs-extra";
import * as path from "path";
import { Config } from "./local-registry";

export const localRegistryPort = 4873;
export const localRegistryUrl = `http://127.0.0.1:${localRegistryPort}`;

export interface YarnProxyOpts {
    registry?: string;
    tag?: string;
}

export const yarnLocalProxyOpts = {
    registry: localRegistryUrl,
    tag: "unit-tests",
};

const topLevelPackageJson = fs.readJsonSync(path.join(repoRootDir, "package.json"));
const verdaccioDir = path.join(repoRootDir, "verdaccio");

export const defaultPublishList =
    topLevelPackageJson.workspaces.packages
        .filter((p: string) => {
            switch (path.basename(p)) {
                case "cli":
                case "testutils":
                    return false;
                default:
                    return true;
            }
        })
        .map((p: string) => path.join(repoRootDir, p));

export async function setupLocalRegistry(publishList: string[], options: YarnProxyOpts = {}): Promise<void> {
    const { tag, ...opts } = { ...yarnLocalProxyOpts, ...options };
    try {
        for (const modDir of publishList) {
            const pkgJson = await fs.readJson(path.join(modDir, "package.json"));
            const modName = pkgJson.name;
            await yarn.publish(modDir, { tag, ...opts });
            // Always clean yarn's cache when publishing a package which
            // might be the same name/version, but with different bits.
            await yarn.cacheClean(modName, opts);
        }
    } catch (err) {
        let output = `Local registry setup failed: ${err.message}`;
        if (err.stderr) output += err.stderr;
        if (err.stdout) output += err.stdout;
        // tslint:disable-next-line:no-console
        console.error(output);
        throw new Error(output);
    }
    // tslint:disable-next-line:no-console
    console.log(`\n>> Local NPM registry started on ${opts.registry} ` +
        `[loaded ${publishList.length} modules]\n`);
}

function setupDefault(): Promise<void> {
    return setupLocalRegistry(defaultPublishList);
}

export const configPath = path.join(verdaccioDir, "config.yaml");
export const config: Config = {
    // Standard verdaccio config items
    storage: path.join(verdaccioDir, "storage"),
    auth: {
        htpasswd: {
            file: path.join(verdaccioDir, "htpasswd")
        }
    },
    uplinks: {
        npmjs: {
            url: "https://registry.npmjs.org/",
            // After 20 errors from the upstream, report an error and
            // mark the upstream as DOWN.
            max_fails: 20,
            // Timeout on each individual request to the upstream
            timeout: "5s",
            // Once the upstream is marked DOWN, it will stay that way
            // for this long before we try to use it again.
            fail_timeout: "1s",
        }
    },
    packages: {
        // Packages from @usys that are not part of our repo workspaces
        "@usys/collections-ts": {
            access: "$all",
            publish: "$all",
            proxy: "npmjs"
        },
        "@usys/fork-require": {
            access: "$all",
            publish: "$all",
            proxy: "npmjs"
        },
        // We don't proxy the remaining @usys packages so we can locally
        // publish the same versions as are on npmjs.
        "@usys/*": {
            access: "$all",
            publish: "$all",
        },
        "**": {
            access: "$all",
            publish: "$all",
            proxy: "npmjs"
        },
    },
    logs: [
        { type: "stdout", format: "pretty", level: "error" }
    ],
    self_path: configPath,

    // Our additional config items
    listen: `0.0.0.0:${localRegistryPort}`,
    onStart: setupDefault,
    clearStorage: false,
};
