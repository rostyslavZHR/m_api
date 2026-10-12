import { Init1791056842389 } from './1791056842389-Init.js';
import { MoneyToMinorUnits1791227100000 } from './1791227100000-MoneyToMinorUnits.js';
import { StockBalanceJobs1791229777721 } from './1791229777721-StockBalanceJobs.js';
import { RuntimeReadOnlySchemaHistory1791300000000 } from './1791300000000-RuntimeReadOnlySchemaHistory.js';

// A list, not a glob: TypeORM loads a glob through a dynamic import that Jest's
// ESM mode can't follow. Add each new migration here; testkit.spec.ts fails if
// a file in this folder is missing.
export const migrations = [
  Init1791056842389,
  MoneyToMinorUnits1791227100000,
  StockBalanceJobs1791229777721,
  RuntimeReadOnlySchemaHistory1791300000000,
];
