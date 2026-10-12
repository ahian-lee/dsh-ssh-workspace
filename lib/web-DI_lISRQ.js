import "./tunnel-BO4E7VdW.js";
import { RemoteDshHostConnection } from "./backend-connection.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request } from "node:http";
/**
* Local control-plane endpoints hidden inside a remote Backend window. Keep
* this exact: the browser bundle may itself be served below `/plugins/`.
*/
const REMOTE_SSH_LOCAL_CONTROL_PATHS = /* @__PURE__ */ new Set([
	"/plugins/dsh-ssh-workspace/state",
	"/plugins/dsh-ssh-workspace/workspace",
	"/plugins/dsh-ssh-workspace/workspace/remove",
	"/plugins/dsh-ssh-workspace/local-workspace",
	"/plugins/dsh-ssh-workspace/probe",
	"/plugins/dsh-ssh-workspace/ssh-config/host",
	"/plugins/dsh-ssh-workspace/settings",
	"/plugins/dsh-ssh-workspace/directory",
	"/plugins/dsh-ssh-workspace/open-file",
	"/plugins/dsh-ssh-workspace/backend/connect"
]);
//#endregion
//#region src/backend/web.ts
/** Local Web asset server and same-origin proxy over a remote dsh-host tunnel. */
const DEFAULT_DSH_BACKEND_PORT = 0;
const COOKIE_PREFIX = "dsh_remote_backend_";
const REMOTE_BROWSER_HOST = "localhost";
/** Serve local Web assets and proxy the unchanged Host protocol on one origin. */
var RemoteDshWebProxy = class RemoteDshWebProxy {
	connection;
	gateway;
	initialRemotePort;
	sockets;
	ownsTunnel;
	localPort;
	url;
	disposed = false;
	constructor(connection, gateway, localPort, initialRemotePort, gatewayToken, sockets, ownsTunnel) {
		this.connection = connection;
		this.gateway = gateway;
		this.initialRemotePort = initialRemotePort;
		this.sockets = sockets;
		this.ownsTunnel = ownsTunnel;
		this.localPort = localPort;
		this.url = `http://${REMOTE_BROWSER_HOST}:${String(localPort)}/?tkn=${encodeURIComponent(gatewayToken)}`;
	}
	get alive() {
		return !this.disposed && this.connection.alive && this.gateway.listening;
	}
	get remotePort() {
		return this.connection.connected ? this.connection.remotePort : this.initialRemotePort;
	}
	static async open(config) {
		const connection = await RemoteDshHostConnection.open(config);
		try {
			return await this.attachInternal(connection, config.localUiPort, true);
		} catch (error) {
			await connection.dispose();
			throw error;
		}
	}
	/** Add the browser same-origin proxy without taking ownership of the SSH tunnel. */
	static attach(connection, localUiPort) {
		return this.attachInternal(connection, localUiPort, false);
	}
	static async attachInternal(connection, localUiPort, ownsTunnel) {
		const tunnel = await connection.ready();
		const gatewayToken = randomBytes(32).toString("hex");
		const cookieName = `${COOKIE_PREFIX}${gatewayToken.slice(0, 16)}`;
		const sockets = /* @__PURE__ */ new Set();
		const gateway = createGateway({
			localUiPort,
			resolveRemote: async () => {
				const active = await connection.ready();
				const token = active.requestHeaders()["x-dsh-host-token"];
				if (token === void 0) throw new Error("dsh-ssh-workspace: Host tunnel did not provide credentials");
				return {
					port: active.localPort,
					token
				};
			},
			gatewayToken,
			cookieName,
			sockets
		});
		try {
			await listenLoopback(gateway);
		} catch (error) {
			throw error;
		}
		const address = gateway.address();
		if (address === null || typeof address === "string") throw new Error("dsh-ssh-workspace: Web proxy has no TCP address");
		return new RemoteDshWebProxy(connection, gateway, address.port, tunnel.remotePort, gatewayToken, sockets, ownsTunnel);
	}
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		const closed = new Promise((resolve) => {
			this.gateway.close(() => {
				resolve();
			});
		});
		this.gateway.closeAllConnections();
		for (const socket of this.sockets) socket.destroy();
		await Promise.all([closed, ...this.ownsTunnel ? [this.connection.dispose()] : []]);
	}
};
function createGateway(options) {
	const server = createServer((req, res) => {
		if (exchangeToken(req, res, options.gatewayToken, options.cookieName)) return;
		if (!cookieMatches(req, options.gatewayToken, options.cookieName)) return unauthorized(res);
		const pathname = new URL(req.url ?? "/", "http://dsh.invalid").pathname;
		if (pathname === "/dsh-ssh-workspace/backend-context") return backendContext(res);
		if (REMOTE_SSH_LOCAL_CONTROL_PATHS.has(pathname)) return localRemoteSshUnavailable(res);
		proxyTarget(req, options).then((target) => {
			proxyHttp(req, res, target);
		}, () => {
			unavailable(res);
		});
	});
	server.on("upgrade", (req, socket, head) => {
		if (!cookieMatches(req, options.gatewayToken, options.cookieName)) {
			socket.destroy();
			return;
		}
		options.sockets.add(socket);
		socket.once("close", () => {
			options.sockets.delete(socket);
		});
		proxyTarget(req, options).then((target) => {
			proxyUpgrade(req, socket, head, target, options.sockets);
		}, () => {
			socket.destroy();
		});
	});
	return server;
}
async function proxyTarget(req, options) {
	const pathname = new URL(req.url ?? "/", "http://dsh.invalid").pathname;
	if (!(pathname === "/api" || pathname.startsWith("/api/") || pathname === "/dsh-host" || pathname.startsWith("/dsh-host/"))) return {
		port: options.localUiPort,
		remote: false
	};
	const target = await options.resolveRemote();
	return {
		port: target.port,
		remote: true,
		token: target.token
	};
}
function proxyHeaders(req, port, remote, remoteToken) {
	const headers = {
		...req.headers,
		host: `127.0.0.1:${String(port)}`
	};
	delete headers.cookie;
	delete headers["proxy-connection"];
	delete headers["x-dsh-host-token"];
	if (remote) headers["x-dsh-host-token"] = remoteToken;
	return headers;
}
function proxyHttp(req, res, target) {
	const upstream = request({
		host: "127.0.0.1",
		port: target.port,
		method: req.method,
		path: req.url,
		headers: proxyHeaders(req, target.port, target.remote, target.token ?? "")
	}, (response) => {
		const headers = { ...response.headers };
		delete headers["set-cookie"];
		res.writeHead(response.statusCode ?? 502, headers);
		response.pipe(res);
	});
	upstream.once("error", () => {
		if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
		res.end("remote backend unavailable");
	});
	req.pipe(upstream);
}
function proxyUpgrade(req, socket, head, target, sockets) {
	const upstream = request({
		host: "127.0.0.1",
		port: target.port,
		method: req.method,
		path: req.url,
		headers: proxyHeaders(req, target.port, target.remote, target.token ?? "")
	});
	upstream.once("upgrade", (response) => {
		const upstreamSocket = response.socket;
		sockets.add(upstreamSocket);
		upstreamSocket.once("close", () => {
			sockets.delete(upstreamSocket);
		});
		socket.write(`HTTP/1.1 ${String(response.statusCode ?? 101)} ${response.statusMessage ?? "Switching Protocols"}\r\n`);
		for (let index = 0; index < response.rawHeaders.length; index += 2) socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
		socket.write("\r\n");
		if (head.length > 0) upstreamSocket.write(head);
		upstreamSocket.pipe(socket);
		socket.pipe(upstreamSocket);
	});
	upstream.once("response", (response) => {
		socket.end(`HTTP/1.1 ${String(response.statusCode ?? 502)} ${response.statusMessage ?? "Bad Gateway"}\r\nConnection: close\r\n\r\n`);
	});
	upstream.once("error", () => {
		socket.destroy();
	});
	upstream.end();
}
function exchangeToken(req, res, expected, cookieName) {
	const url = new URL(req.url ?? "/", "http://dsh.invalid");
	const supplied = url.searchParams.get("tkn");
	if (supplied === null) return false;
	if (!safeEqual(expected, supplied)) {
		unauthorized(res);
		return true;
	}
	url.searchParams.delete("tkn");
	const location = `${url.pathname}${url.search}${url.hash}`;
	res.writeHead(302, {
		location,
		"cache-control": "no-store",
		"set-cookie": `${cookieName}=${expected}; HttpOnly; SameSite=Lax; Path=/`
	});
	res.end();
	return true;
}
function cookieMatches(req, expected, cookieName) {
	const value = (req.headers.cookie ?? "").split(";").map((cookie) => cookie.trim().split("=", 2)).find(([name]) => name === cookieName)?.[1];
	return safeEqual(expected, value);
}
function safeEqual(expected, supplied) {
	if (supplied === void 0) return false;
	const left = Buffer.from(expected);
	const right = Buffer.from(supplied);
	return left.length === right.length && timingSafeEqual(left, right);
}
function unauthorized(res) {
	res.writeHead(401, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end("unauthorized");
}
function backendContext(res) {
	const body = {
		attached: true,
		transport: "ssh"
	};
	res.writeHead(200, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(body));
}
function localRemoteSshUnavailable(res) {
	res.writeHead(409, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify({ error: "Remote SSH controls are unavailable inside a remote Backend window." }));
}
function unavailable(res) {
	if (!res.headersSent) res.writeHead(502, {
		"content-type": "text/plain; charset=utf-8",
		"retry-after": "1"
	});
	res.end("remote backend reconnecting");
}
async function listenLoopback(server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}
//#endregion
export { RemoteDshWebProxy as n, DEFAULT_DSH_BACKEND_PORT as t };
