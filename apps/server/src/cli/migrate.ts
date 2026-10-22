import { migrate } from "../migrate.js";

const applied = await migrate();
console.log(JSON.stringify({ migrated: applied }));
process.exit(0);
