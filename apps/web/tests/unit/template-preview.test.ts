import { describe, expect, it } from "vitest";
import { renderTemplate } from "@sendsprite/shared";
import {
  previewTemplate,
  previewValues,
  undeclaredPlaceholders,
  usedPlaceholders,
  variablesSchemaOf,
  variableRowsOf,
  type DraftFields,
  type VariableRow,
} from "@/app/app/templates/preview";

const row = (over: Partial<VariableRow> = {}): VariableRow => ({
  name: "name",
  type: "string",
  default: "",
  description: "",
  ...over,
});

const draft = (over: Partial<DraftFields> = {}): DraftFields => ({
  subject: "Hello {{name}}",
  bodyHtml: "<p>Hi {{name}}</p>",
  bodyText: "",
  variables: [],
  ...over,
});

describe("usedPlaceholders / undeclaredPlaceholders", () => {
  it("collects every field, deduplicated and sorted", () => {
    const d = draft({
      subject: "{{b}} and {{a}}",
      bodyHtml: "{{a}}",
      bodyText: "{{c}}",
    });
    expect(usedPlaceholders(d)).toEqual(["a", "b", "c"]);
  });

  it("names the placeholders the schema does not declare", () => {
    const d = draft({
      subject: "{{a}}",
      bodyHtml: "{{b}}",
      variables: [row({ name: "a" }), row({ name: "" })],
    });
    expect(undeclaredPlaceholders(d)).toEqual(["b"]);
  });
});

describe("variablesSchemaOf", () => {
  it("drops the blank row, trims, and omits an empty default and description", () => {
    const schema = variablesSchemaOf(
      draft({
        variables: [
          row({ name: " name ", description: "  " }),
          row({ name: "" }),
        ],
      }),
    );
    expect(schema).toEqual({ variables: [{ name: "name", type: "string" }] });
  });

  it("coerces a default to its declared type", () => {
    const schema = variablesSchemaOf(
      draft({
        variables: [
          row({ name: "n", type: "number", default: "42" }),
          row({ name: "b", type: "boolean", default: "TRUE" }),
        ],
      }),
    );
    expect(schema.variables[0]?.default).toBe(42);
    expect(schema.variables[1]?.default).toBe(true);
  });

  // Coercing to NaN would be stored as a JSON `null` and surface much later
  // as a missing variable; left as text, the contract refuses the save.
  it("leaves a default that is not of its declared type as text", () => {
    const schema = variablesSchemaOf(
      draft({
        variables: [row({ name: "n", type: "number", default: "abc" })],
      }),
    );
    expect(schema.variables[0]?.default).toBe("abc");
  });

  it("round-trips the rows a stored schema produces", () => {
    const stored = {
      variables: [
        { name: "n", type: "number" as const, default: 42, description: "d" },
      ],
    };
    expect(
      variablesSchemaOf(draft({ variables: variableRowsOf(stored) })),
    ).toEqual(stored);
  });
});

describe("previewValues", () => {
  it("leaves a declared default to the renderer and stands in for the rest", () => {
    const schema = variablesSchemaOf(
      draft({ variables: [row({ name: "a", default: "Ada" })] }),
    );
    expect(previewValues(["a", "b"], schema)).toEqual({ b: "{b}" });
  });

  it("nests a dotted name, because the renderer walks the path", () => {
    expect(previewValues(["user.first"], { variables: [] })).toEqual({
      user: { first: "{user.first}" },
    });
  });

  it("gives a typed stand-in so a declared type is not reported as invalid", () => {
    const schema = variablesSchemaOf(
      draft({
        variables: [
          row({ name: "n", type: "number" }),
          row({ name: "b", type: "boolean" }),
        ],
      }),
    );
    expect(previewValues(["b", "n"], schema)).toEqual({ n: 0, b: true });
  });

  // A payload cannot make `user` both a scalar and an object, and neither can
  // the preview: the deeper name is left missing, exactly as a send would.
  it("does not overwrite a shorter name with an object", () => {
    expect(previewValues(["user", "user.first"], { variables: [] })).toEqual({
      user: "{user}",
    });
  });
});

describe("previewTemplate", () => {
  it("renders what the send path renders for the same variables", () => {
    const d = draft({
      subject: "Hello {{name}}",
      bodyHtml: "<p>Hi {{name}}</p>",
      bodyText: "Hi {{name}}",
      variables: [row({ name: "name", default: "Ada" })],
    });
    const preview = previewTemplate(d);
    // The same three arguments `renderTemplateRow` assembles from a stored row.
    const send = renderTemplate(
      { subject: d.subject, bodyHtml: d.bodyHtml, bodyText: d.bodyText },
      {},
      variablesSchemaOf(d),
    );
    expect(preview).toEqual(send);
    expect(preview.ok && preview.data.subject).toBe("Hello Ada");
  });

  it("escapes a value in the HTML body and leaves the text body alone", () => {
    const d = draft({
      subject: "Hi",
      bodyHtml: "<p>{{name}}</p>",
      bodyText: "{{name}}",
      variables: [row({ name: "name", default: "<b>&</b>" })],
    });
    const p = previewTemplate(d);
    expect(p.ok && p.data.html).toBe("<p>&lt;b&gt;&amp;&lt;/b&gt;</p>");
    expect(p.ok && p.data.text).toBe("<b>&</b>");
  });

  it("treats an empty text body as no text part", () => {
    const p = previewTemplate(draft({ bodyText: "   " }));
    expect(p.ok && p.data.text).toBe(null);
  });

  it("resolves a dotted placeholder rather than reporting it missing", () => {
    const p = previewTemplate(
      draft({
        subject: "Hi {{user.first}}",
        bodyHtml: "<p>{{user.first}}</p>",
      }),
    );
    expect(p.ok && p.data.html).toBe("<p>{user.first}</p>");
  });

  it("refuses an empty subject, the way a send would", () => {
    const p = previewTemplate(draft({ subject: "  " }));
    expect(p.ok).toBe(false);
  });

  // Escaping is not a URL filter: a `javascript:` href in a *value* survives
  // it intact. That is why the preview renders inside `<iframe sandbox="">`,
  // which runs nothing — the escaping alone would not make this safe.
  it("does not neutralise a javascript: URL in a value", () => {
    const p = previewTemplate(
      draft({
        subject: "Hi",
        bodyHtml: '<a href="{{link}}">go</a>',
        variables: [row({ name: "link", default: "javascript:alert(1)" })],
      }),
    );
    expect(p.ok && p.data.html).toContain("javascript:alert(1)");
  });
});
