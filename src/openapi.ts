import { config } from "./config.js";

export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Schaffa API",
      version: config.version,
      description:
        "Stable HTTP API for publishing standalone HTML pages and files. New HTML pages may be published anonymously for one hour; permanent publishing, page updates, and files use bearer tokens.",
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: config.baseUrl }],
    security: [],
    tags: [
      { name: "Pages", description: "Publish and read standalone HTML pages." },
      { name: "Files", description: "Publish and read immutable files." },
      { name: "Guides", description: "Record, edit, and publish incremental guides." },
    ],
    paths: {
      "/api/pages": {
        post: {
          tags: ["Pages"],
          summary: "Publish a new page",
          description:
            "Without a bearer token, creates an anonymous static page visible for one hour. Interactive pages require an explicitly trusted user and an interactive-only token.",
          operationId: "createPage",
          security: [{}, { bearerAuth: [] }],
          parameters: [titleParameter, pageTypeParameter],
          requestBody: multipartBody("html", "text/html"),
          responses: {
            "202": jsonResponse("Page accepted for virus scanning", {
              $ref: "#/components/schemas/PagePublication",
            }),
            "401": errorResponse("Invalid upload token"),
            "413": errorResponse("HTML exceeds the configured size limit"),
            "429": errorResponse("Upload rate limit exceeded"),
            "422": errorResponse("Rejected HTML or invalid multipart input"),
            "503": errorResponse("Publishing is locked or virus scanning is not configured"),
          },
        },
      },
      "/api/pages/{slug}": {
        put: {
          tags: ["Pages"],
          summary: "Publish a page at a chosen slug",
          description:
            "Creates a permanent page at an unused slug or publishes the next immutable version of a page owned by the bearer token.",
          operationId: "updatePage",
          security: [{ bearerAuth: [] }],
          parameters: [slugParameter, titleParameter, pageTypeParameter],
          requestBody: multipartBody("html", "text/html"),
          responses: {
            "202": jsonResponse("Page version accepted for virus scanning", {
              $ref: "#/components/schemas/PagePublication",
            }),
            "401": errorResponse("Missing or invalid upload token"),
            "403": errorResponse("The token does not own this page"),
            "409": errorResponse("Anonymous pages cannot be updated"),
            "413": errorResponse("HTML exceeds the configured size limit"),
            "429": errorResponse("Upload rate limit exceeded"),
            "422": errorResponse("Rejected HTML, slug, title, or multipart input"),
            "503": errorResponse("Publishing is locked or virus scanning is not configured"),
          },
        },
      },
      "/p/{slug}": pageRead("Read the latest page version", "getLatestPage", [slugParameter]),
      "/p/{slug}/{version}": pageRead("Read a specific page version", "getPageVersion", [
        slugParameter,
        versionParameter,
      ]),
      "/p/{slug}/status": scanStatusRead(
        "Pages",
        "Read the latest page scan status",
        "getPageStatus",
        [slugParameter],
      ),
      "/p/{slug}/{version}/status": scanStatusRead(
        "Pages",
        "Read a page version scan status",
        "getPageVersionStatus",
        [slugParameter, versionParameter],
      ),
      "/p/{slug}/raw": pageRead("Read the latest page source", "getLatestPageSource", [
        slugParameter,
      ]),
      "/p/{slug}/{version}/raw": pageRead(
        "Read a specific page version source",
        "getPageVersionSource",
        [slugParameter, versionParameter],
      ),
      "/p/{slug}/run": pageRead(
        "Run the latest interactive page in its sandbox",
        "runLatestInteractivePage",
        [slugParameter],
      ),
      "/p/{slug}/{version}/run": pageRead(
        "Run a specific interactive page version in its sandbox",
        "runInteractivePageVersion",
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
            "202": jsonResponse("File accepted for virus scanning", {
              $ref: "#/components/schemas/FilePublication",
            }),
            "401": errorResponse("Missing or invalid upload token"),
            "413": errorResponse("File exceeds the configured size limit"),
            "429": errorResponse("Upload rate limit exceeded"),
            "422": errorResponse("Invalid multipart input"),
            "503": errorResponse("Publishing is locked or virus scanning is not configured"),
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
              schema: { type: "string", pattern: "^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$" },
            },
          ],
          responses: {
            "200": binaryResponse("Published file"),
            "202": htmlResponse("Virus scan in progress"),
            "206": binaryResponse("Requested byte range"),
            "422": htmlResponse("Upload rejected by the virus scanner"),
            "404": errorResponse("File not found"),
            "416": errorResponse("Invalid or unsatisfiable range"),
          },
        },
      },
      "/f/{filename}/status": scanStatusRead("Files", "Read a file scan status", "getFileStatus", [
        filenameParameter,
      ]),
      "/api/guides": {
        post: {
          tags: ["Guides"],
          summary: "Start a guide recording",
          operationId: "createGuide",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string", maxLength: 160 },
                    description: { type: "string", maxLength: 4000 },
                    targetUrl: {
                      type: "string",
                      format: "uri",
                      maxLength: 2000,
                      description: "Destination linked from the published guide.",
                    },
                    language: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "201": jsonResponse("Guide recording started", { $ref: "#/components/schemas/Guide" }),
            "401": errorResponse("Missing or invalid upload token"),
          },
        },
      },
      "/api/guides/{slug}": {
        get: {
          tags: ["Guides"],
          summary: "Read the current owner view",
          operationId: "getGuideDraft",
          security: [{ bearerAuth: [] }],
          parameters: [slugParameter],
          responses: {
            "200": jsonResponse("Current guide", { $ref: "#/components/schemas/Guide" }),
            "403": errorResponse("The token does not own this guide"),
          },
        },
        patch: {
          tags: ["Guides"],
          summary: "Edit guide metadata",
          operationId: "updateGuide",
          security: [{ bearerAuth: [] }],
          parameters: [slugParameter, ifMatchParameter],
          responses: {
            "200": jsonResponse("Updated guide", { $ref: "#/components/schemas/Guide" }),
            "409": errorResponse("Edit revision conflict"),
          },
        },
      },
      "/api/guides/{slug}/steps": {
        post: {
          tags: ["Guides"],
          summary: "Append a guide step",
          operationId: "createGuideStep",
          description:
            "Accepts JSON without a screenshot or multipart with a JSON field named step before one screenshot file.",
          security: [{ bearerAuth: [] }],
          parameters: [slugParameter, ifMatchParameter, idempotencyParameter],
          responses: {
            "201": jsonResponse("Step appended", { $ref: "#/components/schemas/Guide" }),
            "409": errorResponse("Edit or idempotency conflict"),
          },
        },
      },
      "/api/guides/{slug}/steps/{stepId}": {
        patch: {
          tags: ["Guides"],
          summary: "Edit a guide step",
          operationId: "updateGuideStep",
          security: [{ bearerAuth: [] }],
          parameters: [slugParameter, stepIdParameter, ifMatchParameter],
          responses: {
            "200": jsonResponse("Step updated", { $ref: "#/components/schemas/Guide" }),
          },
        },
        delete: {
          tags: ["Guides"],
          summary: "Delete a guide step",
          operationId: "deleteGuideStep",
          security: [{ bearerAuth: [] }],
          parameters: [slugParameter, stepIdParameter, ifMatchParameter],
          responses: {
            "200": jsonResponse("Step deleted", { $ref: "#/components/schemas/Guide" }),
          },
        },
      },
      "/api/guides/{slug}/steps/{stepId}/screenshot": {
        put: {
          tags: ["Guides"],
          summary: "Replace a step screenshot",
          operationId: "replaceGuideScreenshot",
          security: [{ bearerAuth: [] }],
          parameters: [slugParameter, stepIdParameter, ifMatchParameter],
          requestBody: multipartBody("screenshot", "image/*"),
          responses: {
            "200": jsonResponse("Screenshot replaced", { $ref: "#/components/schemas/Guide" }),
          },
        },
      },
      "/api/guides/{slug}/order": {
        put: {
          tags: ["Guides"],
          summary: "Reorder every guide step",
          operationId: "reorderGuideSteps",
          security: [{ bearerAuth: [] }],
          parameters: [slugParameter, ifMatchParameter],
          responses: {
            "200": jsonResponse("Guide reordered", { $ref: "#/components/schemas/Guide" }),
          },
        },
      },
      "/api/guides/{slug}/finish": {
        post: {
          tags: ["Guides"],
          summary: "Finish recording and run preflight",
          operationId: "finishGuide",
          security: [{ bearerAuth: [] }],
          parameters: [slugParameter, ifMatchParameter],
          responses: { "200": jsonResponse("Draft and preflight") },
        },
      },
      "/api/guides/{slug}/publish": {
        post: {
          tags: ["Guides"],
          summary: "Publish an immutable revision",
          operationId: "publishGuide",
          security: [{ bearerAuth: [] }],
          parameters: [slugParameter, ifMatchParameter],
          responses: {
            "201": jsonResponse("Published revision"),
            "422": errorResponse("Preflight failed"),
          },
        },
      },
      "/g/{slug}": guideRead("Read the latest published guide", "getPublishedGuide", [
        slugParameter,
      ]),
      "/g/{slug}/{version}": guideRead("Read an immutable guide revision", "getGuideRevision", [
        slugParameter,
        versionParameter,
      ]),
      "/g/{slug}.json": {
        get: {
          tags: ["Guides"],
          summary: "Download guide JSON",
          operationId: "getGuideJson",
          parameters: [slugParameter],
          responses: {
            "200": jsonResponse("Published guide", { $ref: "#/components/schemas/Guide" }),
          },
        },
      },
      "/g/{slug}.md": {
        get: {
          tags: ["Guides"],
          summary: "Download guide Markdown",
          operationId: "getGuideMarkdown",
          parameters: [slugParameter],
          responses: {
            "200": {
              description: "Published guide Markdown",
              content: { "text/markdown": { schema: { type: "string" } } },
            },
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
            slug: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$" },
            title: { type: ["string", "null"], maxLength: 160 },
            kind: { enum: ["static", "interactive"] },
            version: { type: "integer", minimum: 1 },
            bytes: { type: "integer", minimum: 1 },
            sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            publicUrl: { type: "string", format: "uri" },
            versionUrl: { type: "string", format: "uri" },
            rawUrl: { type: "string", format: "uri" },
            versionRawUrl: { type: "string", format: "uri" },
            expiresAt: {
              type: ["string", "null"],
              description: "UTC SQLite timestamp for anonymous pages, otherwise null.",
            },
            purgeAt: {
              type: ["string", "null"],
              description: "UTC SQLite timestamp for anonymous-page retention, otherwise null.",
            },
            scanStatus: { const: "pending" },
            statusUrl: { type: "string", format: "uri" },
          },
          [
            "slug",
            "title",
            "kind",
            "version",
            "bytes",
            "sha256",
            "publicUrl",
            "versionUrl",
            "rawUrl",
            "versionRawUrl",
            "expiresAt",
            "purgeAt",
            "scanStatus",
            "statusUrl",
          ],
        ),
        FilePublication: objectSchema(
          {
            id: { type: "string" },
            filename: { type: "string" },
            mediaType: { type: "string" },
            bytes: {
              type: ["integer", "null"],
              minimum: 0,
              description: "Null while an image is awaiting conversion.",
            },
            sha256: {
              type: ["string", "null"],
              pattern: "^[a-f0-9]{64}$",
              description: "Null while an image is awaiting conversion.",
            },
            publicUrl: { type: "string", format: "uri" },
            scanStatus: { const: "pending" },
            statusUrl: { type: "string", format: "uri" },
          },
          [
            "id",
            "filename",
            "mediaType",
            "bytes",
            "sha256",
            "publicUrl",
            "scanStatus",
            "statusUrl",
          ],
        ),
        ScanStatus: objectSchema(
          {
            scanStatus: { enum: ["pending", "scanning", "clean", "rejected"] },
            message: { type: "string" },
          },
          ["scanStatus"],
        ),
        Guide: objectSchema(
          {
            schemaVersion: { const: 1 },
            slug: { type: "string", pattern: "^[a-z2-7]{12}$" },
            title: { type: "string" },
            targetUrl: { type: ["string", "null"], format: "uri" },
            status: { enum: ["recording", "draft", "published"] },
            revision: { type: "integer", minimum: 0 },
            editRevision: { type: "integer", minimum: 1 },
            publicUrl: { type: "string", format: "uri" },
            apiUrl: { type: "string", format: "uri" },
            steps: { type: "array", items: { type: "object" } },
          },
          [
            "schemaVersion",
            "slug",
            "title",
            "status",
            "revision",
            "editRevision",
            "publicUrl",
            "apiUrl",
            "steps",
          ],
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

const filenameParameter = {
  name: "filename",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;

const stepIdParameter = {
  name: "stepId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;
const ifMatchParameter = {
  name: "If-Match",
  in: "header",
  required: true,
  description: "Current guide editRevision, optionally quoted.",
  schema: { type: "string" },
} as const;
const idempotencyParameter = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", minLength: 8, maxLength: 128 },
} as const;

const titleParameter = {
  name: "title",
  in: "query",
  required: false,
  description: "Optional display title. On updates, omitting it retains the existing title.",
  schema: { type: "string", maxLength: 160 },
} as const;

const pageTypeParameter = {
  name: "type",
  in: "query",
  required: false,
  description:
    "Page execution model. Interactive requires an interactive token and instance/user approval; the value is immutable after creation.",
  schema: { enum: ["static", "interactive"], default: "static" },
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

function htmlResponse(description: string) {
  return {
    description,
    content: { "text/html": { schema: { type: "string" } } },
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
        "202": htmlResponse("Virus scan in progress"),
        "422": htmlResponse("Upload rejected by the virus scanner"),
        "404": {
          description: "Page not found or no longer public",
          content: { "text/html": { schema: { type: "string" } } },
        },
      },
    },
  };
}

function scanStatusRead(
  tag: "Pages" | "Files",
  summary: string,
  operationId: string,
  parameters: readonly object[],
) {
  return {
    get: {
      tags: [tag],
      summary,
      operationId,
      parameters,
      responses: {
        "200": jsonResponse("Scan completed", { $ref: "#/components/schemas/ScanStatus" }),
        "202": jsonResponse("Scan pending", { $ref: "#/components/schemas/ScanStatus" }),
        "404": errorResponse("Publication not found"),
        "422": jsonResponse("Upload rejected", { $ref: "#/components/schemas/ScanStatus" }),
      },
    },
  };
}

function guideRead(summary: string, operationId: string, parameters: readonly object[]) {
  return {
    get: {
      tags: ["Guides"],
      summary,
      operationId,
      parameters,
      responses: {
        "200": {
          description: "Published script-free guide HTML",
          content: { "text/html": { schema: { type: "string" } } },
        },
        "404": errorResponse("No published guide revision"),
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
