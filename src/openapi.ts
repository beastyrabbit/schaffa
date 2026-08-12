import { config } from "./config.js";

export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Schaffa API",
      version: "0.2.1",
      description:
        "Stable HTTP API for publishing standalone HTML pages and files. New HTML pages may be published anonymously for one hour; permanent publishing, page updates, and files use bearer tokens.",
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: config.baseUrl }],
    security: [],
    tags: [
      { name: "Pages", description: "Publish and read standalone HTML pages." },
      { name: "Files", description: "Publish and read immutable files." },
    ],
    paths: {
      "/api/pages": {
        post: {
          tags: ["Pages"],
          summary: "Publish a new page",
          description:
            "Without a bearer token, creates an anonymous page visible for one hour. With an upload token, creates a permanent page.",
          operationId: "createPage",
          security: [{}, { bearerAuth: [] }],
          requestBody: multipartBody("html", "text/html"),
          responses: {
            "201": jsonResponse("Page published", { $ref: "#/components/schemas/PagePublication" }),
            "422": errorResponse("Rejected HTML or invalid multipart input"),
            "503": errorResponse("Publishing is locked or malware scanning is unavailable"),
          },
        },
      },
      "/api/pages/{slug}": {
        put: {
          tags: ["Pages"],
          summary: "Publish the next page version",
          operationId: "updatePage",
          security: [{ bearerAuth: [] }],
          parameters: [slugParameter],
          requestBody: multipartBody("html", "text/html"),
          responses: {
            "200": jsonResponse("New version published", {
              $ref: "#/components/schemas/PagePublication",
            }),
            "401": errorResponse("Missing or invalid upload token"),
            "403": errorResponse("The token does not own this page"),
            "404": errorResponse("Page not found"),
          },
        },
      },
      "/p/{slug}": pageRead("Read the latest page version", "getLatestPage", [slugParameter]),
      "/p/{slug}/{version}": pageRead("Read a specific page version", "getPageVersion", [
        slugParameter,
        versionParameter,
      ]),
      "/p/{slug}/raw": pageRead("Read the latest page source", "getLatestPageSource", [
        slugParameter,
      ]),
      "/p/{slug}/{version}/raw": pageRead(
        "Read a specific page version source",
        "getPageVersionSource",
        [slugParameter, versionParameter],
      ),
      "/api/files": {
        post: {
          tags: ["Files"],
          summary: "Upload a file",
          operationId: "createFile",
          security: [{ bearerAuth: [] }],
          requestBody: multipartBody("file", "application/octet-stream"),
          responses: {
            "201": jsonResponse("File published", { $ref: "#/components/schemas/FilePublication" }),
            "401": errorResponse("Missing or invalid upload token"),
            "422": errorResponse("Invalid multipart input"),
          },
        },
      },
      "/f/{filename}": {
        get: {
          tags: ["Files"],
          summary: "Read a published file",
          operationId: "getFile",
          parameters: [
            {
              name: "filename",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "Range",
              in: "header",
              required: false,
              schema: { type: "string", pattern: "^bytes=[0-9]+-[0-9]*$" },
            },
          ],
          responses: {
            "200": binaryResponse("Published file"),
            "206": binaryResponse("Requested byte range"),
            "404": errorResponse("File not found"),
            "416": errorResponse("Invalid or unsatisfiable range"),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "sfa_ token" },
      },
      schemas: {
        Error: objectSchema({ error: { type: "string" }, message: { type: "string" } }, [
          "error",
          "message",
        ]),
        PagePublication: objectSchema(
          {
            slug: { type: "string", pattern: "^[a-z2-7]{12}$" },
            version: { type: "integer", minimum: 1 },
            publicUrl: { type: "string", format: "uri" },
            versionUrl: { type: "string", format: "uri" },
            rawUrl: { type: "string", format: "uri" },
            expiresAt: { type: ["string", "null"], format: "date-time" },
            purgeAt: { type: ["string", "null"], format: "date-time" },
          },
          ["slug", "version", "publicUrl", "versionUrl", "rawUrl"],
        ),
        FilePublication: objectSchema(
          {
            id: { type: "string" },
            filename: { type: "string" },
            mediaType: { type: "string" },
            bytes: { type: "integer", minimum: 0 },
            publicUrl: { type: "string", format: "uri" },
          },
          ["id", "filename", "mediaType", "bytes", "publicUrl"],
        ),
      },
    },
  } as const;
}

const slugParameter = {
  name: "slug",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$" },
} as const;

const versionParameter = {
  name: "version",
  in: "path",
  required: true,
  schema: { type: "integer", minimum: 1 },
} as const;

function multipartBody(field: string, mediaType: string) {
  return {
    required: true,
    content: {
      "multipart/form-data": {
        schema: objectSchema(
          { [field]: { type: "string", format: "binary", contentMediaType: mediaType } },
          [field],
        ),
      },
    },
  };
}

function jsonResponse(description: string, schema: object = { type: "object" }) {
  return { description, content: { "application/json": { schema } } };
}

function errorResponse(description: string) {
  return jsonResponse(description, { $ref: "#/components/schemas/Error" });
}

function binaryResponse(description: string) {
  return {
    description,
    content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
  };
}

function pageRead(summary: string, operationId: string, parameters: readonly object[]) {
  return {
    get: {
      tags: ["Pages"],
      summary,
      operationId,
      parameters,
      responses: {
        "200": {
          description: "Published HTML",
          content: { "text/html": { schema: { type: "string" } } },
        },
        "404": {
          description: "Page not found or no longer public",
          content: { "text/html": { schema: { type: "string" } } },
        },
      },
    },
  };
}

function objectSchema(
  properties: Record<string, object>,
  required: readonly string[],
): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required };
}
