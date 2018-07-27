import { Action, Plugin, PluginOptions, registerPlugin } from "../../src";

class EchoPlugin implements Plugin {
    _log?: PluginOptions["log"];

    log(...args: any[]) {
        if (this._log == null) throw new Error(`Plugin has no log function`);
        this._log(`${this.constructor.name}:`, ...args);
    }

    async start(options: PluginOptions) {
        if (options.log == null) throw new Error(`Plugin start called without log`);
        this._log = options.log;
        this.log("start");
    }
    async observe(dom: any) {
        this.log("observe", dom);
    }
    analyze(dom: any): Action[] {
        this.log("analyze", dom);
        return [
            { description: "echo action1", act: () => this.doAction("action1") },
            { description: "echo action2", act: () => this.doAction("action2") }
        ];
    }
    async finish() {
        this.log("finish");
    }

    async doAction(msg: string) {
        this.log(msg);
    }
}

export function create() {
    return new EchoPlugin();
}

registerPlugin({
    module,
    create,
});
