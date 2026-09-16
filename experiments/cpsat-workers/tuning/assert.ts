// The model is also used by Workers, without Node.js compatibility or Python.
function check(value: unknown, message = "CP-SAT invariant failed"): asserts value {
  if (!value) throw new Error(message);
}

const assert: {
  (value: unknown, message?: string): asserts value;
  equal(actual: unknown, expected: unknown, message?: string): void;
  deepEqual(actual: unknown, expected: unknown, message?: string): void;
} = Object.assign(check, {
  equal(actual: unknown, expected: unknown, message?: string) {
    check(actual === expected, message);
  },
  deepEqual(actual: unknown, expected: unknown, message?: string) {
    // Used only for sorted preference-field names, never arbitrary objects.
    check(JSON.stringify(actual) === JSON.stringify(expected), message);
  },
});
export default assert;
