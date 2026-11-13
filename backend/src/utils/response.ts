// src/utils/response.ts
export function jsonResponse(
  data: any,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export function successResponse(message?: string): Response {
  return jsonResponse({ success: true, message }, 200);
}

export function createdResponse(data: any): Response {
  return jsonResponse(data, 201);
}

export function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}
