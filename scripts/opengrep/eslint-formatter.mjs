// Preserve every location/rule while omitting source, literal-bearing messages and autofix text.
export default function format(results) {
  return JSON.stringify(
    results.map((result) => ({
      filePath: result.filePath,
      errorCount: result.errorCount,
      warningCount: result.warningCount,
      messages: result.messages.map((message) => ({
        ruleId: message.ruleId,
        line: message.line,
        column: message.column,
        endLine: message.endLine,
        endColumn: message.endColumn,
        severity: message.severity,
        fatal: Boolean(message.fatal),
      })),
    })),
    null,
    2,
  );
}
