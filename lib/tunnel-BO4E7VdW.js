import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { Socket, createServer } from "node:net";
import { dirname, relative, resolve, sep } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
//#region src/backend/install.ts
/** Versioned dsh-host payload discovery and the POSIX SSH bootstrap protocol. */
const ROOT_FILES = [
	"package.json",
	"cordis.patch.yml",
	"LICENSE",
	"README.md",
	"README.zh.md",
	"INSTALL.md",
	"scripts/install.sh"
];
/** Locate an installed dsh-host package, with sibling checkouts as a dev fallback. */
function resolveDshHostPackageRoot(explicitRoot) {
	const candidates = [];
	if (explicitRoot !== void 0) candidates.push(resolve(explicitRoot));
	try {
		candidates.push(dirname(fileURLToPath(import.meta.resolve("dsh-host/package.json"))));
	} catch {}
	const here = dirname(fileURLToPath(import.meta.url));
	candidates.push(resolve(here, "..", "..", "dsh-host"));
	candidates.push(resolve(here, "..", "..", "host"));
	for (const candidate of candidates) if (existsSync(resolve(candidate, "package.json")) && existsSync(resolve(candidate, "lib", "index.js"))) return candidate;
	throw new Error("dsh-ssh-workspace: dsh-host deployment payload is unavailable; install the dsh-host package beside dsh-ssh-workspace");
}
/** Read the exact built package files transferred during automatic installation. */
function loadDshHostPayload(explicitRoot) {
	const root = resolveDshHostPackageRoot(explicitRoot);
	const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	if (manifest.name !== "dsh-host" || typeof manifest.version !== "string" || manifest.version.trim() === "") throw new Error(`dsh-ssh-workspace: invalid dsh-host package at ${JSON.stringify(root)}`);
	const files = [...ROOT_FILES.filter((path) => existsSync(resolve(root, path))), ...walkFiles(resolve(root, "lib")).map((path) => relative(root, path))].map(toPosixPath).sort().map((path) => ({
		path,
		mode: path === "scripts/install.sh" ? "755" : "644",
		data: readFileSync(resolve(root, ...path.split("/")))
	}));
	for (const required of [
		"package.json",
		"cordis.patch.yml",
		"scripts/install.sh",
		"lib/index.js",
		"lib/server.js",
		"lib/startup.js"
	]) if (!files.some((file) => file.path === required)) throw new Error(`dsh-ssh-workspace: dsh-host payload is missing ${required}`);
	const archive = gzipSync(createPackageTar(files), { level: 9 });
	archive[9] = 255;
	const hash = createHash("sha256").update(archive).digest("hex");
	return {
		version: manifest.version,
		hash,
		root,
		files,
		archive
	};
}
/** Encode the npm package for the already-open SSH stdin stream. */
function encodePayloadArchive(payload) {
	return `DSH_REMOTE_BACKEND_ARCHIVE ${payload.archive.toString("base64")}\n`;
}
/** Build the remote installer/launcher that never uses VS Code Server or AHP. */
function buildDshBackendCommand(remotePort) {
	if (!Number.isSafeInteger(remotePort) || remotePort < 0 || remotePort > 65535) throw new Error(`dsh-ssh-workspace: invalid Backend port ${String(remotePort)}`);
	return [
		"set -eu",
		"install_root=\"$HOME/.dsh-host\"",
		"state_dir=\"$install_root/remote-ssh\"",
		"hash_file=\"$state_dir/package-hash\"",
		"lock_dir=\"$state_dir/install.lock\"",
		"mkdir -p \"$state_dir\"",
		"chmod 700 \"$install_root\" \"$state_dir\" 2>/dev/null || true",
		"IFS=\" \" read -r attach_tag requested_hash attach_extra",
		"if [ \"$attach_tag\" != DSH_REMOTE_BACKEND_ATTACH ] || [ -n \"${attach_extra:-}\" ]; then printf 'dsh-ssh-workspace: invalid Backend attach request\\n' >&2; exit 2; fi",
		"case \"$requested_hash\" in *[!0-9a-f]*|\"\") printf 'dsh-ssh-workspace: invalid Backend package hash\\n' >&2; exit 2;; esac",
		"lock_owned=0",
		"upload_dir=\"\"",
		"release_lock() { if [ \"$lock_owned\" = 1 ]; then rm -f \"$lock_dir/owner\"; rmdir \"$lock_dir\" 2>/dev/null || true; lock_owned=0; fi; }",
		"cleanup() { if [ -n \"$upload_dir\" ]; then rm -rf \"$upload_dir\"; fi; release_lock; }",
		"trap cleanup EXIT HUP INT TERM",
		"lock_attempts=0",
		"while ! mkdir \"$lock_dir\" 2>/dev/null; do",
		"  if [ \"$lock_attempts\" = 0 ]; then printf 'DSH_REMOTE_BACKEND_PROGRESS waiting-host\\n'; fi",
		"  lock_owner=\"$(cat \"$lock_dir/owner\" 2>/dev/null || true)\"",
		"  case \"$lock_owner\" in *[!0-9]*|\"\") if [ \"$lock_attempts\" -lt 5 ]; then lock_live=1; else lock_live=0; fi;; *) if kill -0 \"$lock_owner\" 2>/dev/null; then lock_live=1; else lock_live=0; fi;; esac",
		"  if [ \"$lock_live\" = 0 ]; then rm -f \"$lock_dir/owner\"; rmdir \"$lock_dir\" 2>/dev/null || true; continue; fi",
		"  lock_attempts=$((lock_attempts + 1))",
		"  if [ \"$lock_attempts\" -ge 600 ]; then printf 'dsh-ssh-workspace: timed out waiting for Host installation lock\\n' >&2; exit 1; fi",
		"  sleep 1",
		"done",
		"lock_owned=1",
		"printf '%s\\n' \"$$\" > \"$lock_dir/owner\"",
		"chmod 600 \"$lock_dir/owner\"",
		"printf 'DSH_REMOTE_BACKEND_PROGRESS checking-host\\n'",
		"dsh_host=\"$install_root/bin/dsh-host\"",
		"replace_backend=0",
		"current_hash=\"$(cat \"$hash_file\" 2>/dev/null || true)\"",
		"if [ -x \"$dsh_host\" ] && [ \"$current_hash\" = \"$requested_hash\" ]; then",
		"  printf 'DSH_REMOTE_BACKEND_PROGRESS reusing-host\\n'",
		"  printf 'DSH_REMOTE_BACKEND_PAYLOAD CURRENT\\n'",
		"else",
		"  command -v base64 >/dev/null 2>&1 || { printf 'dsh-ssh-workspace: base64 is required to install dsh-host\\n' >&2; exit 127; }",
		"  upload_dir=\"$(mktemp -d \"$state_dir/upload.XXXXXX\")\"",
		"  printf 'DSH_REMOTE_BACKEND_PAYLOAD REQUIRED\\n'",
		"  IFS=\" \" read -r archive_kind encoded_archive archive_extra",
		"  if [ \"$archive_kind\" != DSH_REMOTE_BACKEND_ARCHIVE ] || [ -n \"${archive_extra:-}\" ]; then printf 'dsh-ssh-workspace: invalid Backend package record\\n' >&2; exit 2; fi",
		"  package_archive=\"$upload_dir/dsh-host.tgz\"",
		"  printf '%s' \"$encoded_archive\" | base64 -d > \"$package_archive\"",
		"  actual_hash=\"$(sha256sum \"$package_archive\" | awk '{ print $1 }')\"",
		"  [ \"$actual_hash\" = \"$requested_hash\" ] || { printf 'dsh-ssh-workspace: Backend package hash mismatch\\n' >&2; exit 2; }",
		"  printf 'DSH_REMOTE_BACKEND_PROGRESS installing-host\\n'",
		"  install_script=\"$upload_dir/install.sh\"",
		"  tar -xOzf \"$package_archive\" package/scripts/install.sh > \"$install_script\"",
		"  chmod 700 \"$install_script\"",
		"  DSH_HOST_START=0 DSH_HOST_PACKAGE=\"$package_archive\" sh \"$install_script\"",
		"  rm -rf \"$upload_dir\"",
		"  upload_dir=\"\"",
		"  replace_backend=1",
		"fi",
		"if [ ! -x \"$dsh_host\" ]; then printf 'dsh-ssh-workspace: dsh-host installation did not create a launcher\\n' >&2; exit 127; fi",
		"endpoint_dir=\"$install_root/instances/dsh-ssh-workspace\"",
		"endpoint=\"$endpoint_dir/endpoint.json\"",
		"mkdir -p \"$endpoint_dir\"",
		"printf 'DSH_REMOTE_BACKEND_PROGRESS starting-host\\n'",
		`if [ "$replace_backend" = 1 ]; then "$dsh_host" --instance dsh-ssh-workspace --port ${String(remotePort)} --endpoint-file "$endpoint" --startup-timeout 600 --replace; else "$dsh_host" --instance dsh-ssh-workspace --port ${String(remotePort)} --endpoint-file "$endpoint" --startup-timeout 600; fi`,
		"if [ \"$replace_backend\" = 1 ]; then",
		"  hash_tmp=\"$state_dir/package-hash.$$\"",
		"  printf '%s\\n' \"$requested_hash\" > \"$hash_tmp\"",
		"  chmod 600 \"$hash_tmp\"",
		"  mv \"$hash_tmp\" \"$hash_file\"",
		"fi",
		"dsh_node=\"$install_root/runtime/current/bin/node\"",
		"if [ ! -x \"$dsh_node\" ]; then printf 'dsh-ssh-workspace: private Node.js for dsh-host is missing\\n' >&2; exit 127; fi",
		"ready_port=\"$(\"$dsh_node\" -e 'const fs=require(\"fs\");const e=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\"));process.stdout.write(String(e.port))' \"$endpoint\")\"",
		"case \"$ready_port\" in *[!0-9]*|\"\") printf 'dsh-ssh-workspace: invalid dsh-host endpoint port\\n' >&2; exit 1;; esac",
		"token_file=\"$(\"$dsh_node\" -e 'const fs=require(\"fs\");const e=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\"));process.stdout.write(e.tokenFile)' \"$endpoint\")\"",
		"token=\"$(tr -d '\\r\\n' < \"$token_file\")\"",
		"case \"$token\" in *[!0-9a-fA-F]*|\"\") printf 'dsh-ssh-workspace: invalid dsh-host connection token\\n' >&2; exit 1;; esac",
		"release_lock",
		"printf 'DSH_REMOTE_BACKEND_READY %s %s\\n' \"$ready_port\" \"$token\"",
		"while IFS= read -r dsh_control; do [ \"$dsh_control\" = stop ] && exit 0; done"
	].join("\n");
}
function walkFiles(root) {
	if (!existsSync(root)) return [];
	const files = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = resolve(root, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(path));
		else if (entry.isFile() && statSync(path).isFile()) files.push(path);
	}
	return files;
}
function toPosixPath(path) {
	return sep === "/" ? path : path.split(sep).join("/");
}
function createPackageTar(files) {
	const records = [];
	for (const file of files) {
		const name = `package/${file.path}`;
		if (Buffer.byteLength(name) > 100) throw new Error(`dsh-ssh-workspace: dsh-host package path is too long for ustar: ${name}`);
		const header = Buffer.alloc(512);
		writeTarString(header, 0, 100, name);
		writeTarOctal(header, 100, 8, Number.parseInt(file.mode, 8));
		writeTarOctal(header, 108, 8, 0);
		writeTarOctal(header, 116, 8, 0);
		writeTarOctal(header, 124, 12, file.data.length);
		writeTarOctal(header, 136, 12, 0);
		header.fill(32, 148, 156);
		header[156] = "0".charCodeAt(0);
		writeTarString(header, 257, 6, "ustar");
		writeTarString(header, 263, 2, "00");
		writeTarString(header, 265, 32, "dsh-host");
		writeTarString(header, 297, 32, "dsh-host");
		const checksumText = header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0");
		header.write(checksumText, 148, 6, "ascii");
		header[154] = 0;
		header[155] = 32;
		records.push(header, file.data);
		const remainder = file.data.length % 512;
		if (remainder !== 0) records.push(Buffer.alloc(512 - remainder));
	}
	records.push(Buffer.alloc(1024));
	return Buffer.concat(records);
}
function writeTarString(target, offset, length, value) {
	const data = Buffer.from(value, "utf8");
	if (data.length > length) throw new Error(`dsh-ssh-workspace: tar field is too long: ${value}`);
	data.copy(target, offset);
}
function writeTarOctal(target, offset, length, value) {
	const text = value.toString(8).padStart(length - 1, "0");
	if (text.length >= length) throw new Error(`dsh-ssh-workspace: tar value exceeds field: ${String(value)}`);
	target.write(text, offset, length - 1, "ascii");
	target[offset + length - 1] = 0;
}
//#endregion
//#region src/backend/socks.ts
/** Local TCP forwarding through the dynamic SOCKS port of one OpenSSH process. */
/**
* Expose one local loopback port through OpenSSH's dynamic forward. Unlike
* `ssh -L`, the destination port is learned after the remote Host publishes
* its endpoint, so reconnects do not depend on a fixed server-side port.
*/
async function createSocksForward(localPort, socksPort, remotePort) {
	const sockets = /* @__PURE__ */ new Set();
	const track = (socket) => {
		sockets.add(socket);
		socket.once("close", () => {
			sockets.delete(socket);
		});
	};
	const server = createServer((client) => {
		const socks = new Socket();
		track(client);
		track(socks);
		const fail = () => {
			client.destroy();
			socks.destroy();
		};
		(async () => {
			await connectSocket(socks, socksPort, "127.0.0.1");
			await writeSocket(socks, Buffer.from([
				5,
				1,
				0
			]));
			const greeting = await readExactly(socks, 2);
			if (greeting[0] !== 5 || greeting[1] !== 0) throw new Error("dsh-ssh-workspace: SSH SOCKS proxy rejected unauthenticated connection");
			await writeSocket(socks, Buffer.from([
				5,
				1,
				0,
				1,
				127,
				0,
				0,
				1,
				remotePort >> 8 & 255,
				remotePort & 255
			]));
			const reply = await readExactly(socks, 4);
			if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`dsh-ssh-workspace: SSH SOCKS proxy could not reach remote Host (code ${String(reply[1])})`);
			if (reply[3] === 1) await readExactly(socks, 4);
			else if (reply[3] === 4) await readExactly(socks, 16);
			else if (reply[3] === 3) {
				const length = (await readExactly(socks, 1))[0];
				if (length === void 0) throw new Error("dsh-ssh-workspace: invalid SSH SOCKS address response");
				await readExactly(socks, length);
			} else throw new Error("dsh-ssh-workspace: invalid SSH SOCKS address type");
			await readExactly(socks, 2);
			client.pipe(socks);
			socks.pipe(client);
		})().catch(fail);
	});
	try {
		await new Promise((resolve, reject) => {
			const onError = (error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(localPort, "127.0.0.1");
		});
		return {
			server,
			sockets
		};
	} catch (error) {
		for (const socket of sockets) socket.destroy();
		throw error;
	}
}
async function connectSocket(socket, port, host) {
	await new Promise((resolve, reject) => {
		const onError = (error) => {
			socket.off("connect", onConnect);
			reject(error);
		};
		const onConnect = () => {
			socket.off("error", onError);
			resolve();
		};
		socket.once("error", onError);
		socket.once("connect", onConnect);
		socket.connect(port, host);
	});
}
async function writeSocket(socket, value) {
	if (socket.destroyed || !socket.writable) throw new Error("dsh-ssh-workspace: SSH SOCKS socket closed");
	if (!socket.write(value)) await once(socket, "drain");
}
async function readExactly(socket, length) {
	if (length === 0) return Buffer.alloc(0);
	for (;;) {
		const value = socket.read(length);
		if (value !== null) return value;
		if (socket.destroyed || socket.readableEnded) throw new Error("dsh-ssh-workspace: SSH SOCKS socket closed during handshake");
		await new Promise((resolve, reject) => {
			const cleanup = () => {
				socket.off("readable", onReadable);
				socket.off("error", onError);
				socket.off("end", onClosed);
				socket.off("close", onClosed);
			};
			const onReadable = () => {
				cleanup();
				resolve();
			};
			const onError = (error) => {
				cleanup();
				reject(error);
			};
			const onClosed = () => {
				cleanup();
				reject(/* @__PURE__ */ new Error("dsh-ssh-workspace: SSH SOCKS socket closed during handshake"));
			};
			socket.once("readable", onReadable);
			socket.once("error", onError);
			socket.once("end", onClosed);
			socket.once("close", onClosed);
		});
	}
}
//#endregion
//#region src/backend/tunnel.ts
/** UI-neutral attachment to a persistent remote dsh-host over one SSH process. */
/** Zero lets the remote Host select a collision-free loopback port. */
const DEFAULT_DSH_HOST_PORT = 0;
const DSH_HOST_PROTOCOL_VERSION = 1;
/**
* A transport shared by Web, TUI, and other clients. It installs or reuses the
* Host, keeps one SSH connection alive, and exposes its HTTP/WebSocket endpoint.
*/
var RemoteDshHostTunnel = class RemoteDshHostTunnel {
	ssh;
	forward;
	forwardSockets;
	token;
	localPort;
	remotePort;
	origin;
	/** Resolves whenever the underlying SSH process exits. */
	closed;
	disposed = false;
	constructor(ssh, forward, forwardSockets, localPort, remotePort, token) {
		this.ssh = ssh;
		this.forward = forward;
		this.forwardSockets = forwardSockets;
		this.token = token;
		this.localPort = localPort;
		this.remotePort = remotePort;
		this.origin = `http://127.0.0.1:${String(localPort)}`;
		this.closed = ssh.exitCode === null ? new Promise((resolve) => {
			ssh.once("close", () => {
				resolve();
			});
		}) : Promise.resolve();
	}
	get alive() {
		return !this.disposed && this.ssh.exitCode === null && this.forward.listening;
	}
	/** Headers for direct Host HTTP requests and WebSocket handshakes. */
	requestHeaders() {
		return { "x-dsh-host-token": this.token };
	}
	/** Authenticated WebSocket URL for clients that cannot set handshake headers. */
	webSocketUrl(path) {
		if (!path.startsWith("/")) throw new Error("dsh-ssh-workspace: Host protocol path must start with /");
		const url = new URL(path, this.origin);
		url.protocol = "ws:";
		url.searchParams.set("tkn", this.token);
		return url.toString();
	}
	/** Make an authenticated request over the forwarded Host protocol. */
	fetch(path, init = {}) {
		if (!path.startsWith("/")) throw new Error("dsh-ssh-workspace: Host protocol path must start with /");
		const headers = new Headers(init.headers);
		headers.set("x-dsh-host-token", this.token);
		return globalThis.fetch(`${this.origin}${path}`, {
			...init,
			headers
		});
	}
	/** Read and validate the Host's UI-neutral carrier contract. */
	async describeProtocol(signal) {
		const response = await this.fetch("/dsh-host/protocol", signal === void 0 ? {} : { signal });
		if (!response.ok) throw new Error(`dsh-ssh-workspace: Host protocol discovery failed with HTTP ${String(response.status)}`);
		return parseProtocolDescription(await response.json());
	}
	static async open(config) {
		config.signal?.throwIfAborted();
		emitProgress(config.onProgress, "connecting");
		const payload = loadDshHostPayload(config.packageRoot);
		const ports = await reservePorts(2);
		const localPort = ports[0];
		const socksPort = ports[1];
		if (localPort === void 0 || socksPort === void 0) throw new Error("dsh-ssh-workspace: could not reserve tunnel ports");
		const ssh = spawn(config.sshExecutable, [
			...config.sshArgs,
			"-T",
			"-o",
			"ExitOnForwardFailure=yes",
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ServerAliveCountMax=3",
			"-D",
			`127.0.0.1:${String(socksPort)}`,
			config.sshTarget,
			buildDshBackendCommand(config.remotePort)
		], {
			windowsHide: true,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		const abort = () => {
			ssh.kill();
		};
		config.signal?.addEventListener("abort", abort, { once: true });
		let tunnel;
		try {
			const ready = await installAndWaitForHost(ssh, payload, config.startupTimeoutMs, config.onProgress);
			await waitForPort(socksPort, ssh, 15e3);
			const { server: forward, sockets } = await createSocksForward(localPort, socksPort, ready.remotePort);
			tunnel = new RemoteDshHostTunnel(ssh, forward, sockets, localPort, ready.remotePort, ready.token);
			await tunnel.describeProtocol();
			emitProgress(config.onProgress, "ready");
			return tunnel;
		} catch (error) {
			if (tunnel !== void 0) await tunnel.dispose();
			else ssh.kill();
			throw error;
		} finally {
			config.signal?.removeEventListener("abort", abort);
		}
	}
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		const forwardClosed = new Promise((resolve) => {
			this.forward.close(() => {
				resolve();
			});
		});
		for (const socket of this.forwardSockets) socket.destroy();
		try {
			this.ssh.stdin.end("stop\n");
		} catch {}
		if (!await waitForChildClose(this.ssh, 2e3)) this.ssh.kill();
		await forwardClosed;
	}
};
function parseProtocolDescription(value) {
	if (!isRecord(value) || value.protocol !== "dsh-host" || value.protocolVersion !== 1 || value.transport !== "http+websocket" || value.rpcPath !== "/api/{method}" || typeof value.muxEventsPath !== "string" || typeof value.hostEventsPath !== "string" || !Array.isArray(value.capabilities) || value.capabilities.some((capability) => typeof capability !== "string")) throw new Error("dsh-ssh-workspace: remote Host uses an incompatible protocol");
	return value;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function installAndWaitForHost(child, payload, timeoutMs, onProgress) {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let state = "decision";
		const reportedStages = /* @__PURE__ */ new Set();
		const finish = (operation) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stdout.off("data", onStdout);
			child.stderr.off("data", onStderr);
			child.off("error", onError);
			child.off("close", onClose);
			operation();
		};
		const fail = (error) => {
			finish(() => {
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		};
		const inspect = () => {
			if (settled) return;
			for (const match of stdout.matchAll(/(?:^|\n)DSH_(?:REMOTE_BACKEND|HOST)_PROGRESS ([a-z-]+)(?=\r?\n|$)/g)) {
				const stage = match[1];
				if (stage !== void 0 && isProgressStage(stage) && !reportedStages.has(stage)) {
					reportedStages.add(stage);
					emitProgress(onProgress, stage);
				}
			}
			if (state === "decision") {
				if (/(?:^|\n)DSH_REMOTE_BACKEND_PAYLOAD CURRENT(?:\r?\n|$)/.test(stdout)) state = "ready";
				else if (/(?:^|\n)DSH_REMOTE_BACKEND_PAYLOAD REQUIRED(?:\r?\n|$)/.test(stdout)) {
					state = "sending";
					emitProgress(onProgress, "uploading-host");
					writePayload(child, payload).then(() => {
						if (settled) return;
						state = "ready";
						inspect();
					}, fail);
					return;
				}
			}
			if (state !== "ready") return;
			const match = /(?:^|\n)DSH_REMOTE_BACKEND_READY ([0-9]{1,5}) ([0-9a-fA-F]{64})(?:\r?\n|$)/.exec(stdout);
			const remotePort = Number(match?.[1]);
			const token = match?.[2];
			if (token !== void 0 && Number.isSafeInteger(remotePort) && remotePort >= 1 && remotePort <= 65535) finish(() => {
				resolve({
					remotePort,
					token
				});
			});
		};
		const onStdout = (chunk) => {
			stdout = (stdout + chunk.toString("utf8")).slice(-1048576);
			inspect();
		};
		const onStderr = (chunk) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-65536);
		};
		const onError = (error) => {
			fail(error);
		};
		const onClose = (code) => {
			finish(() => {
				reject(/* @__PURE__ */ new Error(`dsh-ssh-workspace: Host SSH exited ${String(code)} before readiness${stderr.trim() ? `\n${stderr.trim()}` : ""}`));
			});
		};
		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);
		child.once("error", onError);
		child.once("close", onClose);
		const timer = setTimeout(() => {
			finish(() => {
				reject(/* @__PURE__ */ new Error(`dsh-ssh-workspace: Host startup timed out after ${String(timeoutMs)}ms${stderr.trim() ? `\n${stderr.trim()}` : ""}`));
			});
		}, timeoutMs);
		writeStdin(child, `DSH_REMOTE_BACKEND_ATTACH ${payload.hash}\n`).catch(fail);
	});
}
function emitProgress(listener, stage) {
	try {
		listener?.({ stage });
	} catch {}
}
function isProgressStage(value) {
	return value === "connecting" || value === "reconnecting" || value === "waiting-host" || value === "checking-host" || value === "uploading-host" || value === "reusing-host" || value === "installing-host" || value === "checking-runtime" || value === "installing-node" || value === "installing-pnpm" || value === "installing-harness" || value === "verifying-runtime" || value === "installing-bundle" || value === "installed" || value === "starting-host" || value === "ready" || value === "failed";
}
async function writePayload(child, payload) {
	await writeStdin(child, encodePayloadArchive(payload));
}
async function writeStdin(child, value) {
	if (child.stdin.destroyed || !child.stdin.writable) throw new Error("dsh-ssh-workspace: Host SSH stdin closed during installation");
	if (!child.stdin.write(value)) await once(child.stdin, "drain");
}
async function reservePorts(count) {
	const servers = [];
	try {
		for (let index = 0; index < count; index += 1) {
			const server = createServer();
			servers.push(server);
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject);
					resolve();
				});
			});
		}
		return servers.map((server) => {
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("could not reserve a TCP port");
			return address.port;
		});
	} finally {
		await Promise.all(servers.map((server) => new Promise((resolve) => {
			server.close(() => {
				resolve();
			});
		})));
	}
}
async function waitForPort(port, child, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (child.exitCode !== null) throw new Error(`dsh-ssh-workspace: Host SSH exited ${String(child.exitCode)} before the tunnel opened`);
		if (await new Promise((resolve) => {
			const socket = new Socket();
			socket.once("error", () => {
				socket.destroy();
				resolve(false);
			});
			socket.connect(port, "127.0.0.1", () => {
				socket.destroy();
				resolve(true);
			});
		})) return;
		if (Date.now() >= deadline) throw new Error(`dsh-ssh-workspace: Host tunnel did not open within ${String(timeoutMs)}ms`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
async function waitForChildClose(child, timeoutMs) {
	if (child.exitCode !== null) return true;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.off("close", onClose);
			resolve(false);
		}, timeoutMs);
		const onClose = () => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("close", onClose);
	});
}
//#endregion
export { buildDshBackendCommand as a, parseProtocolDescription as i, DSH_HOST_PROTOCOL_VERSION as n, RemoteDshHostTunnel as r, DEFAULT_DSH_HOST_PORT as t };
