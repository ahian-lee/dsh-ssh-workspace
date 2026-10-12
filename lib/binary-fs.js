//#region src/transport/binary-fs.ts
/** Require binary publication without falling back to a host path or subprocess. */
function binaryWriter(fs) {
	if (typeof fs.writeBytes !== "function") throw new Error("filesystem backend does not implement writeBytes");
	return fs;
}
//#endregion
export { binaryWriter };
