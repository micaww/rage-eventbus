import * as util from './util';

const environment = util.getEnvironment();
if(!environment) throw 'Unknown RAGE environment';

const ERR_NOT_FOUND = 'PROCEDURE_NOT_FOUND';

const IDENTIFIER = '__rpc:id';
const PROCESS_EVENT = '__rpc:process';
const BROWSER_REGISTER = '__rpc:browserRegister';
const BROWSER_UNREGISTER = '__rpc:browserUnregister';

const glob = environment === "cef" ? window : global;

if(!glob[PROCESS_EVENT]){
    glob.__eventListeners = {};
    glob.__rpcListeners = {};
    glob.__rpcPending = {};

    glob[PROCESS_EVENT] = (player: Player | string, rawData?: string) => {
        if(environment !== "server") rawData = player as string;
        const data: Event = util.parseData(rawData);

        if(data.req){ // someone is trying to remotely call a procedure
            const info: ProcedureListenerInfo = {
                id: data.id,
                environment: data.fenv || data.env
            };
            if(environment === "server") info.player = player as Player;
            const part = {
                ret: 1,
                id: data.id,
                env: environment
            };
            let ret: (ev: Event) => void;
            switch(environment){
                case "server":
                    ret = ev => info.player.call(PROCESS_EVENT, [util.stringifyData(ev)]);
                    break;
                case "client": {
                    if(data.env === "server"){
                        ret = ev => mp.events.callRemote(PROCESS_EVENT, util.stringifyData(ev));
                    }else if(data.env === "cef"){
                        const browser = data.b && glob.__rpcBrowsers[data.b];
                        info.browser = browser;
                        ret = ev => browser && util.isBrowserValid(browser) && passEventToBrowser(browser, ev, true);
                    }
                    break;
                }
                case "cef": {
                    ret = ev => mp.trigger(PROCESS_EVENT, util.stringifyData(ev));
                }
            }
            if(ret){
                if(data.trigger) triggerEvent(data.name, data.args, info)
                else callProcedure(data.name, data.args, info).then(res => ret({ ...part, res })).catch(err => ret({ ...part, err }));
            }
        }else if(data.ret){ // a previously called remote procedure has returned
            const info = glob.__rpcPending[data.id];
            if(environment === "server" && info.player !== player) return;
            if(info){
                info.resolve(data.err ? util.promiseReject(data.err) : util.promiseResolve(data.res));
                delete glob.__rpcPending[data.id];
            }
        }
    };

    if(environment !== "cef"){
        mp.events.add(PROCESS_EVENT, glob[PROCESS_EVENT]);

        if(environment === "client"){
            // set up internal pass-through events
            register('__rpc:callServer', ([name, args], info) => _callServer(name, args, { fenv: info.environment }));
            register('__rpc:callBrowsers', ([name, args], info) => _callBrowsers(null, name, args, { fenv: info.environment }));

            on('__rpc:triggerServer', ([name, args], info) => _triggerServer(name, args, { fenv: info.environment }));
            on('__rpc:triggerBrowsers', ([name, args], info) => _triggerBrowsers(null, name, args, { fenv: info.environment }));

            // set up browser identifiers
            glob.__rpcBrowsers = {};
            const initBrowser = (browser: Browser): void => {
                const id = util.uid();
                Object.keys(glob.__rpcBrowsers).forEach(key => {
                    const b = glob.__rpcBrowsers[key];
                    if(!b || !util.isBrowserValid(b) || b === browser) delete glob.__rpcBrowsers[key];
                });
                glob.__rpcBrowsers[id] = browser;
                browser.execute(`if(typeof window['${IDENTIFIER}'] === 'undefined'){ window['${IDENTIFIER}'] = Promise.resolve('${id}'); }else{ window['${IDENTIFIER}:resolve']('${id}'); }`);
            };
            mp.browsers.forEach(initBrowser);
            mp.events.add('browserCreated', initBrowser);

            // set up browser registration map
            glob.__rpcBrowserProcedures = {};
            mp.events.add(BROWSER_REGISTER, (data: string) => {
                const [browserId, name] = JSON.parse(data);
                glob.__rpcBrowserProcedures[name] = browserId;
            });
            mp.events.add(BROWSER_UNREGISTER, (data: string) => {
                const [browserId, name] = JSON.parse(data);
                if(glob.__rpcBrowserProcedures[name] === browserId) delete glob.__rpcBrowserProcedures[name];
            });
        }
    }else{
        if(typeof glob[IDENTIFIER] === 'undefined'){
            glob[IDENTIFIER] = new Promise(resolve => {
                glob[IDENTIFIER+':resolve'] = resolve;
            });
        }
    }
}

function passEventToBrowser(browser: Browser, data: Event, ignoreNotFound: boolean): void {
    const raw = util.stringifyData(data).replace(/'/g, "\\'");
    browser.execute(`var process = window["${PROCESS_EVENT}"]; if(process){ process('${raw}'); }else{ ${ignoreNotFound ? '' : `mp.trigger("${PROCESS_EVENT}", '{"ret":1,"id":"${data.id}","err":"${ERR_NOT_FOUND}","env":"cef"}');`} }`);
}

function callProcedure(name: string, args: any, info: ProcedureListenerInfo): Promise<any> {
    const listener = glob.__rpcListeners[name];
    if(!listener) return util.promiseReject(ERR_NOT_FOUND);
    return util.promiseResolve(listener(args, info));
}

/**
 * Register a procedure.
 * @param {string} name - The name of the procedure.
 * @param {function} cb - The procedure's callback. The return value will be sent back to the caller.
 */
export function register(name: string, cb: ProcedureListener): void {
    if(arguments.length !== 2) throw 'register expects 2 arguments: "name" and "cb"';
    if(environment === "cef") glob[IDENTIFIER].then((id: string) => mp.trigger(BROWSER_REGISTER, JSON.stringify([id, name])));
    glob.__rpcListeners[name] = cb;
}

/**
 * Unregister a procedure.
 * @param {string} name - The name of the procedure.
 */
export function unregister(name: string): void {
    if(arguments.length !== 1) throw 'unregister expects 1 argument: "name"';
    if(environment === "cef") glob[IDENTIFIER].then((id: string) => mp.trigger(BROWSER_UNREGISTER, JSON.stringify([id, name])));
    glob.__rpcListeners[name] = undefined;
}

/**
 * Calls a local procedure. Only procedures registered in the same context will be resolved.
 *
 * Can be called from any environment.
 *
 * @param name - The name of the locally registered procedure.
 * @param args - Any parameters for the procedure.
 * @returns The result from the procedure.
 */
export function call(name: string, args?: any): Promise<any> {
    if(arguments.length !== 1 && arguments.length !== 2) return util.promiseReject('call expects 1 or 2 arguments: "name" and optional "args"');
    return callProcedure(name, args, { environment });
}

function _callServer(name: string, args?: any, extraData = {}): Promise<any> {
    switch(environment){
        case "server": {
            return call(name, args);
        }
        case "client": {
            const id = util.uid();
            return new Promise(resolve => {
                glob.__rpcPending[id] = {
                    resolve
                };
                const event: Event = {
                    req: 1,
                    id,
                    name,
                    env: environment,
                    args,
                    ...extraData
                };
                mp.events.callRemote(PROCESS_EVENT, util.stringifyData(event));
            });
        }
        case "cef": {
            return callClient('__rpc:callServer', [name, args]);
        }
    }
}

/**
 * Calls a remote procedure registered on the server.
 *
 * Can be called from any environment.
 *
 * @param name - The name of the registered procedure.
 * @param args - Any parameters for the procedure.
 * @returns The result from the procedure.
 */
export function callServer(name: string, args?: any): Promise<any> {
    if(arguments.length !== 1 && arguments.length !== 2) return util.promiseReject('callServer expects 1 or 2 arguments: "name" and optional "args"');
    return _callServer(name, args, {});
}

/**
 * Calls a remote procedure registered on the client.
 *
 * Can be called from any environment.
 *
 * @param player - The player to call the procedure on.
 * @param name - The name of the registered procedure.
 * @param args - Any parameters for the procedure.
 * @returns The result from the procedure.
 */
export function callClient(player: Player | string, name?: string | any, args?: any): Promise<any> {
    switch(environment){
        case "client": {
            args = name;
            name = player;
            if((arguments.length !== 1 && arguments.length !== 2) || typeof name !== "string") return util.promiseReject('callClient from the client expects 1 or 2 arguments: "name" and optional "args"');
            return call(name, args);
        }
        case "server": {
            if((arguments.length !== 2 && arguments.length !== 3) || typeof player !== "object") return util.promiseReject('callClient from the server expects 2 or 3 arguments: "player", "name", and optional "args"');
            const id = util.uid();
            return new Promise(resolve => {
                glob.__rpcPending[id] = {
                    resolve,
                    player
                };
                const event: Event = {
                    req: 1,
                    id,
                    name,
                    env: environment,
                    args
                };
                player.call(PROCESS_EVENT, [util.stringifyData(event)]);
            });
        }
        case "cef": {
            args = name;
            name = player;
            if((arguments.length !== 1 && arguments.length !== 2) || typeof name !== "string") return util.promiseReject('callClient from the browser expects 1 or 2 arguments: "name" and optional "args"');
            const id = util.uid();
            return glob[IDENTIFIER].then((browserId: string) => {
                return new Promise(resolve => {
                    glob.__rpcPending[id] = {
                        resolve
                    };
                    const event: Event = {
                        b: browserId,
                        req: 1,
                        id,
                        name,
                        env: environment,
                        args
                    };
                    mp.trigger(PROCESS_EVENT, util.stringifyData(event));
                });
            });
        }
    }
}

function _callBrowser(id: string, browser: Browser, name: string, args?: any, extraData = {}): Promise<any> {
    return new Promise(resolve => {
        glob.__rpcPending[id] = {
            resolve
        };
        passEventToBrowser(browser, {
            req: 1,
            id,
            name,
            env: environment,
            args,
            ...extraData
        }, false);
    });
}

function _callBrowsers(player: Player, name: string, args?: any, extraData = {}): Promise<any> {
    switch(environment){
        case "client":
            const id = util.uid();
            const browserId = glob.__rpcBrowserProcedures[name];
            if(!browserId) return util.promiseReject(ERR_NOT_FOUND);
            const browser = glob.__rpcBrowsers[browserId];
            if(!browser || !util.isBrowserValid(browser)) return util.promiseReject(ERR_NOT_FOUND);
            return _callBrowser(id, browser, name, args, extraData);
        case "server":
            return callClient(player, '__rpc:callBrowsers', [name, args]);
        case "cef":
            return callClient('__rpc:callBrowsers', [name, args]);
    }
}

/**
 * Calls a remote procedure registered in any browser context.
 *
 * Can be called from any environment.
 *
 * @param player - The player to call the procedure on.
 * @param name - The name of the registered procedure.
 * @param args - Any parameters for the procedure.
 * @returns The result from the procedure.
 */
export function callBrowsers(player: Player | string, name?: string | any, args?: any): Promise<any> {
    switch(environment){
        case "client":
        case "cef":
            if(arguments.length !== 1 && arguments.length !== 2) return util.promiseReject('callBrowsers from the client or browser expects 1 or 2 arguments: "name" and optional "args"');
            return _callBrowsers(null, player as string, name, {});
        case "server":
            if(arguments.length !== 2 && arguments.length !== 3) return util.promiseReject('callBrowsers from the server expects 2 or 3 arguments: "player", "name", and optional "args"');
            return _callBrowsers(player as Player, name, args, {});
    }
}

/**
 * Calls a remote procedure registered in a specific browser instance.
 *
 * Client-side environment only.
 *
 * @param browser - The browser instance.
 * @param name - The name of the registered procedure.
 * @param args - Any parameters for the procedure.
 * @returns The result from the procedure.
 */
export function callBrowser(browser: Browser, name: string, args?: any): Promise<any> {
    if(environment !== 'client') return util.promiseReject('callBrowser can only be used in the client environment');
    if(arguments.length !== 2 && arguments.length !== 3) return util.promiseReject('callBrowser expects 2 or 3 arguments: "browser", "name", and optional "args"');
    const id = util.uid();
    return _callBrowser(id, browser, name, args, {});
}

function triggerEvent(name: string, args: any, info: ProcedureListenerInfo): void {
    if (glob.__eventListeners[name])
        glob.__eventListeners[name].forEach((cb: any) =>
            util.promiseResolve(cb(args, info)))
}

/**
 * Register an event listener.
 * @param {string} name - The name of the event.
 * @param {function} cb - The event's callback.
 */
export function on(name: string, cb: EventListener): void {
    if(arguments.length !== 2) throw 'on expects 2 arguments: "name" and "cb"';
    if(environment === "cef") glob[IDENTIFIER].then((id: string) => mp.trigger(BROWSER_REGISTER, JSON.stringify([id, name])));
    if(!glob.__eventListeners[name]) glob.__eventListeners[name] = new Set()
    glob.__eventListeners[name].add(cb);
}

/**
 * Unregister an event listener.
 * @param {string} name - The name of the event.
 * @param {function} cb - The event's callback.
 */
export function off(name: string, cb: EventListener): void {
    if(arguments.length !== 2) throw 'off expects 2 arguments: "name" and "cb"';
    if(environment === "cef") glob[IDENTIFIER].then((id: string) => mp.trigger(BROWSER_UNREGISTER, JSON.stringify([id, name])));
    if(!glob.__eventListeners[name]) glob.__eventListeners[name] = new Set()
    glob.__eventListeners[name].delete(cb);
}

/**
 * Triggers a local event. Only events registered in the same context will be resolved.
 *
 * Can be called from any environment.
 *
 * @param name - The name of the locally registered event.
 * @param args - Any parameters for the event.
 * @returns Nothing.
 */
export function trigger(name: string, args?: any): void {
    triggerEvent(name, args, {environment})
}

function _triggerServer(name: string, args?: any, extraData = {}) {
    switch(environment) {
        case "server": trigger(name, args); break;
        case "client": {
            const event = { trigger: true, req: 1, name, env: environment, args, ...extraData};
            mp.events.callRemote(PROCESS_EVENT, util.stringifyData(event))
        }; break;
        case "cef": triggerClient('__rpc:triggerServer', [name, args])
    }
}

/**
 * Triggers a remote event registered on the server.
 *
 * Can be called from any environment.
 *
 * @param name - The name of the registered event.
 * @param args - Any parameters for the event.
 * @returns Nothing.
 */
export function triggerServer(name: string, args?: any): void {
    if(arguments.length !== 1 && arguments.length !== 2)
        throw 'triggerServer expects 1 or 2 arguments: "name" and optional "args"'

    _triggerServer(name, args, {});
}

/**
 * Triggers a remote event registered on the client.
 *
 * Can be called from any environment.
 *
 * @param player - The player to call the event on.
 * @param name - The name of the registered event.
 * @param args - Any parameters for the event.
 * @returns Nothing.
 */
export function triggerClient(player: Player | string, name?: string | any, args?: any): void {
    switch (environment) {
        case "client": {
            args = name;
            name = player;

            if((arguments.length !== 1 && arguments.length !== 2) || typeof name !== "string")
                throw 'triggerClient from the client expects 1 or 2 arguments: "name" and optional "args"'

            trigger(name, args)
        }; break;

        case "server": {
            if((arguments.length !== 2 && arguments.length !== 3) || typeof player !== "object")
                throw 'triggerClient from the server expects 2 or 3 arguments: "player", "name", and optional "args"'

            const id = util.uid();

            const event: Event = {
                trigger: true,
                req: 1,
                id,
                name,
                env: environment,
                args
            };

            player.call(PROCESS_EVENT, [util.stringifyData(event)]);
        }; break;

        case "cef": {
            args = name;
            name = player;

            if((arguments.length !== 1 && arguments.length !== 2) || typeof name !== "string")
                throw 'triggerClient from the browser expects 1 or 2 arguments: "name" and optional "args"'

            const id = util.uid();

            return glob[IDENTIFIER].then((browserId: string) => {
                const event: Event = {
                    trigger: true,
                    b: browserId,
                    req: 1,
                    id,
                    name,
                    env: environment,
                    args
                };

                mp.trigger(PROCESS_EVENT, util.stringifyData(event));
            });
        }
    }
}

function _triggerBrowser(id: string, browser: Browser, name: string, args?: any, extraData = {}): void {
    passEventToBrowser(browser, {
        trigger: true,
        req: 1,
        id,
        name,
        env: environment,
        args,
        ...extraData
    }, false);
}

function _triggerBrowsers(player: Player, name: string, args?: any, extraData = {}): void {
    switch(environment){
        case "client": {
            const id = util.uid();

            const browserId = glob.__rpcBrowserProcedures[name];
            if(!browserId) throw ERR_NOT_FOUND

            const browser = glob.__rpcBrowsers[browserId];
            if(!browser || !util.isBrowserValid(browser))
                throw ERR_NOT_FOUND

            _triggerBrowser(id, browser, name, args, extraData);
        }; break;

        case "server":
            triggerClient(player, '__rpc:triggerBrowsers', [name, args]); break;

        case "cef":
            triggerClient('__rpc:triggerBrowsers', [name, args]); break;
    }
}


/**
 * Triggers a remote event registered in any browser context.
 *
 * Can be called from any environment.
 *
 * @param player - The player to call the event on.
 * @param name - The name of the registered event.
 * @param args - Any parameters for the event.
 * @returns Nothing.
 */
export function triggerBrowsers(player: Player | string, name?: string | any, args?: any): void {
    switch(environment) {
        case "client":
        case "cef": {
            if(arguments.length !== 1 && arguments.length !== 2)
                throw 'triggerBrowsers from the client or browser expects 1 or 2 arguments: "name" and optional "args"'

            _triggerBrowsers(null, player as string, name, {trigger: true});
        }; break;

        case "server": {
            if(arguments.length !== 2 && arguments.length !== 3)
                throw 'triggerBrowsers from the server expects 2 or 3 arguments: "player", "name", and optional "args"'

            _triggerBrowsers(player as Player, name, args, {trigger: true});
        }; break;
    }
}


/**
 * Casts a remote event registered in a specific browser instance.
 *
 * Client-side environment only.
 *
 * @param browser - The browser instance.
 * @param name - The name of the registered event.
 * @param args - Any parameters for the event.
 * @returns Nothing.
 */
export function triggerBrowser(browser: Browser, name: string, args?: any): void {
    if(environment !== 'client')
        throw 'triggerBrowser can only be used in the client environment'

    if(arguments.length !== 2 && arguments.length !== 3)
        throw 'triggerBrowser expects 2 or 3 arguments: "browser", "name", and optional "args"'

    const id = util.uid();
    _triggerBrowser(id, browser, name, args, {});
}
