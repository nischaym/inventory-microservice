/** A-10: request body limit for feeds. One source for the parser limit and the 413 message. */
export const MAX_BODY_SIZE_MEGABYTES = 10;

const BYTES_PER_MEGABYTE = 1024 * 1024;

export const MAX_BODY_SIZE_BYTES = MAX_BODY_SIZE_MEGABYTES * BYTES_PER_MEGABYTE;
