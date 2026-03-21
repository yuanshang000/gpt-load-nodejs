export type RunResult = {
  changes: number;
  lastInsertRowid: number;
};

export interface StatementLike {
  get(...args: unknown[]): any;
  all(...args: unknown[]): any[];
  run(...args: unknown[]): RunResult;
}

export interface DatabaseLike {
  prepare(sql: string): StatementLike;
  exec(sql: string): void;
  pragma(sql: string): void;
  transaction<T extends (...args: any[]) => any>(fn: T): T;
  close(): void;
}

