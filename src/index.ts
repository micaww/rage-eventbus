import * as util from './util';

const environment = util.getEnvironment();
if(!environment) throw 'Unknown RAGE environment';

const ERR_NOT_FOUND = 'PROCEDURE_NOT_FOUND';

const IDENTIFIER = '__rpc:id';
const PROCESS_EVENT = '__rpc:process';
const BROWSER_REGISTER = '__rpc:browserRegister';
const BROWSER_UNREGISTER = '__rpc:browserUnregister';
const TRIGGER_EVENT = '__rpc:triggerEvent';
const TRIGGER_EVENT_BROWSERS = '__rpc:triggerEventBrowsers';

const glob = environment === 'cef' ? window : global;

if(!glob[PROCESS_EVENT]){
    glob.__rpcListeners = {};
    glob.__rpcPending = {};
    glob.__rpcEvListeners = {};

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
                const promise = callProcedure(data.name, data.args, info);
                if(!data.noRet) promise.then(res => ret({ ...part, res })).catch(err => ret({ ...part, err: err ? err : null }));
            }
        }else if(data.ret){ // a previously called remote procedure has returned
            const info = glob.__rpcPending[data.id];
            if(environment === "server" && info.player !== player) return;
            if(info){
                info.resolve(data.hasOwnProperty('err') ? Promise.reject(data.err) : Promise.resolve(data.res));
                delete glob.__rpcPending[data.id];
            }
        }
    };

    if(environment !== "cef"){
        mp.events.add(PROCESS_EVENT, glob[PROCESS_EVENT]);

        if(environment === "client"){
            // set up internal pass-through events
            register('__rpc:callServer', ([name, args, noRet], info) => _callServer(name, args, { fenv: info.environment, noRet }));
            register('__rpc:callBrowsers', ([name, args, noRet], info) => _callBrowsers(null, name, args, { fenv: info.environment, noRet }));

            // set up browser identifiers
            glob.__rpcBrowsers = {};
            const initBrowser = (browser: Browser): void => {
                const id = util.uid();
                Object.keys(glob.__rpcBrowsers).forEach(key => {
                    const b = glob.__rpcBrowsers[key];
                    if(!b || !util.isBrowserValid(b) || b === browser) delete glob.__rpcBrowsers[key];
                });
                glob.__rpcBrowsers[id] = browser;
                browser.execute(`
                    window.name = '${id}';
                    if(typeof window['${IDENTIFIER}'] === 'undefined'){
                        window['${IDENTIFIER}'] = Promise.resolve(window.name);
                    }else{
                        window['${IDENTIFIER}:resolve'](window.name);
                    }
                `);
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

            register(TRIGGER_EVENT_BROWSERS, ([name, args], info) => {
                Object.values(glob.__rpcBrowsers).forEach(browser => {
                    _callBrowser(browser, TRIGGER_EVENT, [name, args], { fenv: info.environment, noRet: 1 });
                });
            });
        }
    }else{
        if(typeof glob[IDENTIFIER] === 'undefined'){
            glob[IDENTIFIER] = new Promise(resolve => {
                if (window.name) {
                    resolve(window.name);
                }else{
                    glob[IDENTIFIER+':resolve'] = resolve;
                }
            });
        }
    }

    register(TRIGGER_EVENT, ([name, args], info) => callEvent(name, args, info));
}

function passEventToBrowser(browser: Browser, data: Event, ignoreNotFound: boolean): void {
    const raw = util.stringifyData(data);
    browser.execute(`var process = window["${PROCESS_EVENT}"]; if(process){ process(${JSON.stringify(raw)}); }else{ ${ignoreNotFound ? '' : `mp.trigger("${PROCESS_EVENT}", '{"ret":1,"id":"${data.id}","err":"${ERR_NOT_FOUND}","env":"cef"}');`} }`);
}

function callProcedure(name: string, args: any, info: ProcedureListenerInfo): Promise<any> {
    const listener = glob.__rpcListeners[name];
    if(!listener) return Promise.reject(ERR_NOT_FOUND);
    return Promise.resolve(listener(args, info));
}

/**
 * Register a procedure.
 * @param {string} name - The name of the procedure.
 * @param {function} cb - The procedure's callback. The return value will be sent back to the caller.
 * @returns {Function} The function, which unregister the event.
 */
export function register(name: string, cb: ProcedureListener): Function {
    if(arguments.length !== 2) throw 'register expects 2 arguments: "name" and "cb"';
    if(environment === "cef") glob[IDENTIFIER].then((id: string) => mp.trigger(BROWSER_REGISTER, JSON.stringify([id, name])));
    glob.__rpcListeners[name] = cb;

    return () => unregister(name);
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
 * @param options - Any options.
 * @returns The result from the procedure.
 */
export function call(name: string, args?: any, options: CallOptions = {}): Promise<any> {
    if(arguments.length < 1 || arguments.length > 3) return Promise.reject('call expects 1 to 3 arguments: "name", optional "args", and optional "options"');
    return util.promiseTimeout(callProcedure(name, args, { environment }), options.timeout);
}

function _callServer(name: string, args?: any, extraData: any = {}): Promise<any> {
    switch(environment){
        case "server": {
            return call(name, args);
        }
        case "client": {
            const id = util.uid();
            return new Promise(resolve => {
                if(!extraData.noRet){
                    glob.__rpcPending[id] = {
                        resolve
                    };
                }
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
            return callClient('__rpc:callServer', [name, args, +extraData.noRet]);
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
 * @param options - Any options.
 * @returns The result from the procedure.
 */
export function callServer(name: string, args?: any, options: CallOptions = {}): Promise<any> {
    if(arguments.length < 1 || arguments.length > 3) return Promise.reject('callServer expects 1 to 3 arguments: "name", optional "args", and optional "options"');

    let extraData: any = {};
    if(options.noRet) extraData.noRet = 1;

    return util.promiseTimeout(_callServer(name, args, extraData), options.timeout);
}

function _callClient(player: Player, name: string, args?: any, extraData: any = {}): Promise<any> {
    switch(environment){
        case 'client': {
            return call(name, args);
        }
        case 'server': {
            const id = util.uid();
            return new Promise(resolve => {
                if(!extraData.noRet){
                    glob.__rpcPending[id] = {
                        resolve,
                        player
                    };
                }
                const event: Event = {
                    req: 1,
                    id,
                    name,
                    env: environment,
                    args,
                    ...extraData
                };
                player.call(PROCESS_EVENT, [util.stringifyData(event)]);
            });
        }
        case 'cef': {
            const id = util.uid();
            return glob[IDENTIFIER].then((browserId: string) => {
                return new Promise(resolve => {
                    if(!extraData.noRet){
                        glob.__rpcPending[id] = {
                            resolve
                        };
                    }
                    const event: Event = {
                        b: browserId,
                        req: 1,
                        id,
                        name,
                        env: environment,
                        args,
                        ...extraData
                    };
                    mp.trigger(PROCESS_EVENT, util.stringifyData(event));
                });
            });
        }
    }
}

/**
 * Calls a remote procedure registered on the client.
 *
 * Can be called from any environment.
 *
 * @param player - The player to call the procedure on.
 * @param name - The name of the registered procedure.
 * @param args - Any parameters for the procedure.
 * @param options - Any options.
 * @returns The result from the procedure.
 */
export function callClient(player: Player | string, name?: string | any, args?: any, options: CallOptions = {}): Promise<any> {
    switch(environment){
        case 'client': {
            options = args || {};
            args = name;
            name = player;
            player = null;
            if((arguments.length < 1 || arguments.length > 3) || typeof name !== 'string') return Promise.reject('callClient from the client expects 1 to 3 arguments: "name", optional "args", and optional "options"');
            break;
        }
        case 'server': {
            if((arguments.length < 2 || arguments.length > 4) || typeof player !== 'object') return Promise.reject('callClient from the server expects 2 to 4 arguments: "player", "name", optional "args", and optional "options"');
            break;
        }
        case 'cef': {
            options = args || {};
            args = name;
            name = player;
            player = null;
            if((arguments.length < 1 || arguments.length > 3) || typeof name !== 'string') return Promise.reject('callClient from the browser expects 1 to 3 arguments: "name", optional "args", and optional "options"');
            break;
        }
    }

    let extraData: any = {};
    if(options.noRet) extraData.noRet = 1;

    return util.promiseTimeout(_callClient(player as Player, name, args, extraData), options.timeout);
}

function _callBrowser(browser: Browser, name: string, args?: any, extraData: any = {}): Promise<any> {
    return new Promise(resolve => {
        const id = util.uid();
        if(!extraData.noRet){
            glob.__rpcPending[id] = {
                resolve
            };
        }
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

function _callBrowsers(player: Player, name: string, args?: any, extraData: any = {}): Promise<any> {
    switch(environment){
        case 'client':
            const browserId = glob.__rpcBrowserProcedures[name];
            if(!browserId) return Promise.reject(ERR_NOT_FOUND);
            const browser = glob.__rpcBrowsers[browserId];
            if(!browser || !util.isBrowserValid(browser)) return Promise.reject(ERR_NOT_FOUND);
            return _callBrowser(browser, name, args, extraData);
        case 'server':
            return _callClient(player, '__rpc:callBrowsers', [name, args, +extraData.noRet], extraData);
        case 'cef':
            return _callClient(null, '__rpc:callBrowsers', [name, args, +extraData.noRet], extraData);
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
 * @param options - Any options.
 * @returns The result from the procedure.
 */
export function callBrowsers(player: Player | string, name?: string | any, args?: any, options: CallOptions = {}): Promise<any> {
    let promise;
    let extraData: any = {};

    switch(environment){
        case 'client':
        case 'cef':
            options = args || {};
            args = name;
            name = player;
            if(arguments.length < 1 || arguments.length > 3) return Promise.reject('callBrowsers from the client or browser expects 1 to 3 arguments: "name", optional "args", and optional "options"');
            if(options.noRet) extraData.noRet = 1;
            promise = _callBrowsers(null, name, args, extraData);
            break;
        case 'server':
            if(arguments.length < 2 || arguments.length > 4) return Promise.reject('callBrowsers from the server expects 2 to 4 arguments: "player", "name", optional "args", and optional "options"');
            if(options.noRet) extraData.noRet = 1;
            promise = _callBrowsers(player as Player, name, args, extraData);
            break;
    }

    if(promise){
        return util.promiseTimeout(promise, options.timeout);
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
 * @param options - Any options.
 * @returns The result from the procedure.
 */
export function callBrowser(browser: Browser, name: string, args?: any, options: CallOptions = {}): Promise<any> {
    if(environment !== 'client') return Promise.reject('callBrowser can only be used in the client environment');
    if(arguments.length < 2 || arguments.length > 4) return Promise.reject('callBrowser expects 2 to 4 arguments: "browser", "name", optional "args", and optional "options"');

    let extraData: any = {};
    if(options.noRet) extraData.noRet = 1;

    return util.promiseTimeout(_callBrowser(browser, name, args, extraData), options.timeout);
}

function callEvent(name: string, args: any, info: ProcedureListenerInfo){
    const listeners = glob.__rpcEvListeners[name];
    if(listeners){
        listeners.forEach(listener => listener(args, info));
    }
}

/**
 * Register an event handler.
 * @param {string} name - The name of the event.
 * @param cb - The callback for the event.
 * @returns {Function} The function, which off the event.
 */
export function on(name: string, cb: ProcedureListener): Function {
    if(arguments.length !== 2) throw 'on expects 2 arguments: "name" and "cb"';

    const listeners = glob.__rpcEvListeners[name] || new Set();
    listeners.add(cb);
    glob.__rpcEvListeners[name] = listeners;

    return () => off(name, cb);
}

/**
 * Unregister an event handler.
 * @param {string} name - The name of the event.
 * @param cb - The callback for the event.
 */
export function off(name: string, cb: ProcedureListener){
    if(arguments.length !== 2) throw 'off expects 2 arguments: "name" and "cb"';

    const listeners = glob.__rpcEvListeners[name];
    if(listeners){
        listeners.delete(cb);
    }
}

/**
 * Triggers a local event. Only events registered in the same context will be triggered.
 *
 * Can be called from any environment.
 *
 * @param name - The name of the locally registered event.
 * @param args - Any parameters for the event.
 */
export function trigger(name: string, args?: any){
    if(arguments.length < 1 || arguments.length > 2) throw 'trigger expects 1 or 2 arguments: "name", and optional "args"';
    callEvent(name, args, { environment });
}

/**
 * Triggers an event registered on the client.
 *
 * Can be called from any environment.
 *
 * @param player - The player to call the procedure on.
 * @param name - The name of the event.
 * @param args - Any parameters for the event.
 */
export function triggerClient(player: Player | string, name?: string | any, args?: any){
    switch(environment){
        case 'client': {
            args = name;
            name = player;
            player = null;
            if((arguments.length < 1 || arguments.length > 2) || typeof name !== 'string') throw 'triggerClient from the client expects 1 or 2 arguments: "name", and optional "args"';
            break;
        }
        case 'server': {
            if((arguments.length < 2 || arguments.length > 3) || typeof player !== 'object') throw 'triggerClient from the server expects 2 or 3 arguments: "player", "name", and optional "args"';
            break;
        }
        case 'cef': {
            args = name;
            name = player;
            player = null;
            if((arguments.length < 1 || arguments.length > 2) || typeof name !== 'string') throw 'triggerClient from the browser expects 1 or 2 arguments: "name", and optional "args"';
            break;
        }
    }

    _callClient(player as Player, TRIGGER_EVENT, [name, args], { noRet: 1 });
}

/**
 * Triggers an event registered on the server.
 *
 * Can be called from any environment.
 *
 * @param name - The name of the event.
 * @param args - Any parameters for the event.
 */
export function triggerServer(name: string, args?: any){
    if(arguments.length < 1 || arguments.length > 2) throw 'triggerServer expects 1 or 2 arguments: "name", and optional "args"';

    _callServer(TRIGGER_EVENT, [name, args], { noRet: 1 });
}

/**
 * Triggers an event registered in any browser context.
 *
 * Can be called from any environment.
 *
 * @param player - The player to call the procedure on.
 * @param name - The name of the event.
 * @param args - Any parameters for the event.
 */
export function triggerBrowsers(player: Player | string, name?: string | any, args?: any){
    switch(environment){
        case 'client':
        case 'cef':
            args = name;
            name = player;
            player = null;
            if(arguments.length < 1 || arguments.length > 2) throw 'triggerBrowsers from the client or browser expects 1 or 2 arguments: "name", and optional "args"';
            break;
        case 'server':
            if(arguments.length < 2 || arguments.length > 3) throw 'triggerBrowsers from the server expects 2 or 3 arguments: "player", "name", and optional "args"';
            break;
    }

    _callClient(player as Player, TRIGGER_EVENT_BROWSERS, [name, args], { noRet: 1 });
}

/**
 * Triggers an event registered in a specific browser instance.
 *
 * Client-side environment only.
 *
 * @param browser - The browser instance.
 * @param name - The name of the event.
 * @param args - Any parameters for the event.
 */
export function triggerBrowser(browser: Browser, name: string, args?: any){
    if(environment !== 'client') throw 'callBrowser can only be used in the client environment';
    if(arguments.length < 2 || arguments.length > 4) throw 'callBrowser expects 2 or 3 arguments: "browser", "name", and optional "args"';

    _callBrowser(browser, TRIGGER_EVENT, [name, args], { noRet: 1});
}

export default {
    register,
    unregister,
    call,
    callServer,
    callClient,
    callBrowsers,
    callBrowser,
    on,
    off,
    trigger,
    triggerServer,
    triggerClient,
    triggerBrowsers,
    triggerBrowser
};