"use client";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
  key?: string,
): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? { cache: "no-store" }
      : {
          method,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key || crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined")
      window.location.assign(
        `/login?returnTo=${encodeURIComponent(window.location.pathname)}`,
      );
    throw new ApiError(data.error || "请求失败，请重试", response.status);
  }
  return data as T;
}
