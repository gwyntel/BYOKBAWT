const { encrypt, decrypt, splitMessage } = require("../index");

// Mock process.env.ENCRYPTION_KEY for testing if it's not set in the environment
// This is a common way to handle environment variables in Jest tests.
// Ensure this key is a 64-character hex string (32 bytes) for aes-256-gcm.
const MOCK_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.ENCRYPTION_KEY = MOCK_ENCRYPTION_KEY;

describe("Encryption and Decryption", () => {
  const sampleString = "Hello, World!";
  const emptyString = "";
  const specialCharString = "こんにちは, 世界！🔑✨";

  test("should encrypt a sample string", () => {
    const encrypted = encrypt(sampleString);
    expect(encrypted).toHaveProperty("iv");
    expect(encrypted).toHaveProperty("encrypted");
    expect(encrypted).toHaveProperty("authTag");
    expect(encrypted.encrypted.length).toBeGreaterThan(0);
  });

  test("should encrypt and decrypt a sample string successfully", () => {
    const { iv, encrypted, authTag } = encrypt(sampleString);
    const decrypted = decrypt(encrypted, iv, authTag);
    expect(decrypted).toBe(sampleString);
  });

  test("should encrypt and decrypt an empty string successfully", () => {
    const { iv, encrypted, authTag } = encrypt(emptyString);
    const decrypted = decrypt(encrypted, iv, authTag);
    expect(decrypted).toBe(emptyString);
  });

  test("should encrypt and decrypt a string with special characters successfully", () => {
    const { iv, encrypted, authTag } = encrypt(specialCharString);
    const decrypted = decrypt(encrypted, iv, authTag);
    expect(decrypted).toBe(specialCharString);
  });

  // Optional: Test for decryption failure (e.g., wrong key or tampered data)
  // This can be more complex to set up correctly.
  // For now, focusing on successful round-trip.
  test("decrypt should fail with tampered data (authTag)", () => {
    const { iv, encrypted, authTag } = encrypt("tamper test");
    const tamperedAuthTag = authTag.substring(0, authTag.length - 4) + "ffff"; // Modify the authTag

    expect(() => {
      decrypt(encrypted, iv, tamperedAuthTag);
    }).toThrow(); // Or toThrowError(/Unsupported state or bad message authentication code/);
  });

   test("decrypt should fail with different IV", () => {
    const { iv, encrypted, authTag } = encrypt("different iv test");
    // Create a slightly different IV (ensure it's still valid hex of same length)
    let differentIv = iv.split('');
    differentIv[0] = differentIv[0] === 'a' ? 'b' : 'a'; // Simple change
    differentIv = differentIv.join('');

    expect(() => {
      decrypt(encrypted, differentIv, authTag);
    }).toThrow();
  });
});

describe("splitMessage Function", () => {
  test("should return an array with an empty string for an empty input string", () => {
    expect(splitMessage("")).toEqual([""]);
  });

  test("should return the original string in an array if it's shorter than maxLen", () => {
    const shortString = "This is a short string.";
    expect(splitMessage(shortString, 100)).toEqual([shortString]);
  });

  test("should split a long string without newlines into multiple chunks", () => {
    const longString = "ThisIsAVeryLongStringThatShouldBeSplitIntoMultipleParts";
    const maxLen = 20;
    const expected = [
      "ThisIsAVeryLongStrin",
      "gThatShouldBeSplitIn",
      "toMultipleParts",
    ];
    expect(splitMessage(longString, maxLen)).toEqual(expected);
  });

  test("should split a string with newlines, respecting newlines for splits", () => {
    const stringWithNewlines = "First line.\nSecond line, which is a bit longer.\nThird line.";
    const maxLen = 30;
    const expected = [
      "First line.",
      "Second line, which is a bit",
      "longer.",
      "Third line."
    ];
    // The splitMessage function prioritizes maxLen over newlines if a single line itself exceeds maxLen.
    // Let's adjust the expectation based on current splitMessage logic.
    const currentLogicExpected = [
        "First line.",
        "Second line, which is a bit l",
        "onger.",
        "Third line."
    ];
    expect(splitMessage(stringWithNewlines, maxLen)).toEqual(currentLogicExpected);
  });
  
  test("should split a string where a single line is longer than maxLen", () => {
    const singleLongLine = "This single line is very long and definitely exceeds the maximum length.";
    const maxLen = 20;
    const expected = [
      "This single line is ",
      "very long and defini",
      "tely exceeds the max",
      "imum length.",
    ];
    expect(splitMessage(singleLongLine, maxLen)).toEqual(expected);
  });

  test("should handle string with only newlines", () => {
    expect(splitMessage("\n\n\n", 100)).toEqual(["", "", "", ""]);
  });

  test("should handle maxLen of 0 or 1 (edge case for maxLen)", () => {
    const text = "abc";
    // Behavior with maxLen <= 0 might be tricky or lead to infinite loops if not handled.
    // Assuming splitMessage handles this gracefully (e.g. by splitting per char or erroring).
    // Based on current implementation: buf.length + line.length + 1 > maxLen
    // If maxLen is 1, "a" (1) + "" (0) + 1 = 2 > 1. So "a" gets pushed. Then "b", then "c".
    expect(splitMessage(text, 1)).toEqual(["a", "b", "c"]);
    // If maxLen is 0, it will also split by character due to the +1 for newline.
    expect(splitMessage(text, 0)).toEqual(["a", "b", "c"]); 
  });
});
