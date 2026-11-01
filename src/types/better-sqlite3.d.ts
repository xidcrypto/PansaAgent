declare module "better-sqlite3" {
  interface Database {
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }
  interface Statement {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  }
  interface DatabaseConstructor {
    new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }): Database;
  }
  const Database: DatabaseConstructor;
  export default Database;
}