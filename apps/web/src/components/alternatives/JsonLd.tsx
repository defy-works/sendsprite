/**
 * Schema.org structured data. The JSON is escaped so a `</script>` inside a
 * string can never close the tag; React does not do that for
 * `dangerouslySetInnerHTML`.
 */
export function JsonLd({ data }: { data: object | object[] }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
