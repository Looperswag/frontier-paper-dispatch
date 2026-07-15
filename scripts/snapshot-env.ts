import { readSecureFile, writeSecureFileExclusive } from "../lib/secure-file.ts";
import { ConfigError } from "../lib/runtime-config.ts";

const [, , source, destination] = process.argv;
if (!source || !destination) {
  throw new ConfigError([{ code: "INVALID", key: "environment snapshot path" }]);
}
const snapshot = readSecureFile(source, {
  expectedMode: 0o600,
  key: ".env",
  required: true,
});
writeSecureFileExclusive(destination, snapshot!.text);
