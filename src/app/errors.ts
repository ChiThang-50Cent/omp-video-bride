export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}
export const notFound = (what: string, id: string) => new AppError(404, "not_found", `${what} ${id} not found`);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const invalid = (message: string) => new AppError(400, "invalid_request", message);
