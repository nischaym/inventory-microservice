export const HTTP_STATUS = {
  ok: 200,
  created: 201,
  badRequest: 400,
  notFound: 404,
  conflict: 409,
  payloadTooLarge: 413,
  unsupportedMediaType: 415,
  unprocessableEntity: 422,
  internalServerError: 500,
  serviceUnavailable: 503,
} as const;

/** First status of each class, for range checks. */
export const HTTP_STATUS_CLASS_START = {
  clientError: 400,
  serverError: 500,
} as const;
