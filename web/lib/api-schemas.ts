import { z } from "zod";

const MAX_COORDINATE = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

export const canonicalUUID = z
  .string()
  .regex(UUID)
  .transform((value) => value.toLowerCase());

const coordinate = z.number().min(-MAX_COORDINATE).max(MAX_COORDINATE);
const dimension = z.number().min(0).max(MAX_COORDINATE);
const color = z.string().regex(/^#[0-9a-f]{6}$/i).default("#e0c060");
const annotationBody = z
  .string()
  .refine((value) => [...value].length <= 1_000)
  .refine((value) => encoder.encode(value).byteLength <= 4_096)
  .nullable()
  .optional()
  .default(null);
const point = z.tuple([coordinate, coordinate]);
const rect = z.strictObject({
  h: dimension,
  w: dimension,
  x: coordinate,
  y: coordinate,
});
const normalizedCoordinate = z.number().min(0).max(1);
const normalizedRect = z.strictObject({
  h: normalizedCoordinate,
  w: normalizedCoordinate,
  x: normalizedCoordinate,
  y: normalizedCoordinate,
}).refine((value) => value.x + value.w <= 1.000_001 && value.y + value.h <= 1.000_001);
const versioned = {
  contentVersion: z.string().regex(/^[a-f0-9]{64}$/),
  v: z.literal(2),
};

const common = {
  body: annotationBody,
  color,
  itemId: canonicalUUID,
};

export const annotationMutationSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...common,
      anchor: z.union([
        z.strictObject({ rects: z.array(rect).min(1).max(256) }),
        z.strictObject({
          ...versioned,
          prefix: z.string().max(128),
          quote: z.string().min(1).max(1_000),
          rects: z.array(normalizedRect).min(1).max(256),
          suffix: z.string().max(128),
        }),
      ]),
      type: z.literal("highlight"),
    }),
    z.strictObject({
      ...common,
      anchor: z.union([
        z.strictObject({ x: coordinate, y: coordinate }),
        z.strictObject({ ...versioned, x: normalizedCoordinate, y: normalizedCoordinate }),
      ]),
      type: z.literal("note"),
    }),
    z.strictObject({
      ...common,
      anchor: z.union([
        z.strictObject({ points: z.array(point).min(2).max(2_048) }),
        z.strictObject({
          ...versioned,
          points: z.array(z.tuple([normalizedCoordinate, normalizedCoordinate])).min(2).max(2_048),
        }),
      ]),
      type: z.literal("pen"),
    }),
    z.strictObject({
      ...common,
      anchor: z.union([
        rect,
        normalizedRect.extend(versioned),
      ]),
      type: z.literal("box"),
    }),
  ])
  .refine((value) => encoder.encode(JSON.stringify(value.anchor)).byteLength <= 20_000);

export const annotationListQuerySchema = z.strictObject({ itemId: canonicalUUID });
export const annotationDeleteQuerySchema = z.strictObject({ id: canonicalUUID });

const chatMessage = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => [...value].length >= 1 && [...value].length <= 2_000)
  .refine((value) => encoder.encode(value).byteLength <= 8_192);

export const chatHistoryQuerySchema = z.strictObject({ itemId: canonicalUUID });
export const chatMutationSchema = z.strictObject({
  itemId: canonicalUUID,
  message: chatMessage,
});

export const exportPathSchema = z.strictObject({ id: canonicalUUID });
export const exportQuerySchema = z.strictObject({
  format: z.enum(["md", "docx"]).default("md"),
});

const feedbackNote = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => [...value].length >= 1 && [...value].length <= 500)
  .refine((value) => encoder.encode(value).byteLength <= 2_048);

export const feedbackMutationSchema = z.strictObject({
  itemId: canonicalUUID,
  note: feedbackNote.nullable().optional().default(null),
  rating: z.enum(["up", "down"]),
});

export const feedbackRedemptionSchema = z.strictObject({
  token: z
    .string()
    .min(1)
    .refine((value) => encoder.encode(value).byteLength <= 256),
});
