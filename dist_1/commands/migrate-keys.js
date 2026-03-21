"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMigrateKeys = exports.printMigrateHelp = void 0;
const parseArgs = (argv) => {
    const parsed = { from: "", to: "" };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if ((arg === "--from" || arg === "-f") && argv[index + 1]) {
            parsed.from = argv[index + 1];
            index += 1;
            continue;
        }
        if ((arg === "--to" || arg === "-t") && argv[index + 1]) {
            parsed.to = argv[index + 1];
            index += 1;
            continue;
        }
    }
    return parsed;
};
const printMigrateHelp = () => {
    console.log("GPT-Load Node.js Key Migration Tool");
    console.log("");
    console.log("Usage:");
    console.log("  npm run migrate-keys -- --to <new-key>");
    console.log("  npm run migrate-keys -- --from <old-key>");
    console.log("  npm run migrate-keys -- --from <old-key> --to <new-key>");
    console.log("");
    console.log("Scenarios:");
    console.log("  Enable encryption: --to");
    console.log("  Disable encryption: --from");
    console.log("  Rotate key: --from + --to");
};
exports.printMigrateHelp = printMigrateHelp;
const runMigrateKeys = (service, argv) => {
    const args = parseArgs(argv);
    if (!args.from && !args.to) {
        (0, exports.printMigrateHelp)();
        return 0;
    }
    try {
        const result = service.migrateEncryptionKeys(args.from, args.to);
        console.log("Migration completed successfully.");
        console.log(JSON.stringify({
            from: args.from ? "***configured***" : "<plaintext>",
            to: args.to ? "***configured***" : "<plaintext>",
            ...result,
        }, null, 2));
        return 0;
    }
    catch (error) {
        console.error("Migration failed:", error instanceof Error ? error.message : error);
        return 1;
    }
};
exports.runMigrateKeys = runMigrateKeys;
