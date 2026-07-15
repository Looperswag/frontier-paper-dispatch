export type DatabaseErrorCode =
  | "DB_INTEGRITY_FAILED"
  | "DB_NOT_FOUND"
  | "DB_OPERATION_FAILED";

function providerCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value)
    ? value
    : undefined;
}

class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;
  readonly operation: string;

  constructor(code: DatabaseErrorCode, operation: string, message: string) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
    this.operation = operation;
  }
}

export class DatabaseOperationError extends DatabaseError {
  readonly providerCode?: string;

  constructor(operation: string, providerError?: unknown) {
    const code = providerCode(providerError);
    super(
      "DB_OPERATION_FAILED",
      operation,
      `Database operation failed: ${operation}${code ? ` (${code})` : ""}`,
    );
    this.name = "DatabaseOperationError";
    this.providerCode = code;
  }
}

export class DatabaseIntegrityError extends DatabaseError {
  constructor(operation: string) {
    super(
      "DB_INTEGRITY_FAILED",
      operation,
      `Database integrity check failed: ${operation}`,
    );
    this.name = "DatabaseIntegrityError";
  }
}

export class DatabaseNotFoundError extends DatabaseError {
  constructor(operation: string) {
    super("DB_NOT_FOUND", operation, `Database record not found: ${operation}`);
    this.name = "DatabaseNotFoundError";
  }
}

export function databaseData<T>(
  operation: string,
  result: Readonly<{ data: T; error: unknown }>,
): T {
  if (result.error) throw new DatabaseOperationError(operation, result.error);
  return result.data;
}

export function assertDatabaseIntegrity(
  operation: string,
  condition: unknown,
): asserts condition {
  if (!condition) throw new DatabaseIntegrityError(operation);
}

export function isDatabaseUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
