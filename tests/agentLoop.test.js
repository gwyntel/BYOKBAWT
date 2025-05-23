// Test file for agentLoop function and related logic
const { Readable } = require("stream");

// --- Mocks ---
const mockDbRun = jest.fn();
const mockDbGet = jest.fn();
const mockDbAll = jest.fn();
const mockWebhookSend = jest.fn();
const mockFetch = jest.fn();

global.fetch = mockFetch; // Mock global fetch

jest.mock("better-sqlite3", () => {
  return jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockImplementation((sql) => {
      // console.log(`DB Prepare: ${sql}`); // For debugging
      if (sql.includes("INSERT INTO messages")) return { run: mockDbRun };
      if (sql.includes("SELECT contextWindow, loopDepth FROM guildSettings")) return { get: mockDbGet };
      if (sql.includes("SELECT * FROM providers WHERE guildId=? AND name=?")) return { get: mockDbGet };
      if (sql.includes("SELECT m.role, m.content, m.agentId, a.name as agentName")) return { all: mockDbAll };
      // Add more specific mocks if other SQL queries are made by agentLoop
      return { run: mockDbRun, get: mockDbGet, all: mockDbAll }; // Default fallback
    }),
    exec: jest.fn(),
    pragma: jest.fn().mockReturnValue([]),
  }));
});

jest.mock("discord.js", () => {
  const originalModule = jest.requireActual("discord.js");
  return {
    ...originalModule,
    WebhookClient: jest.fn().mockImplementation(() => ({
      send: mockWebhookSend,
    })),
  };
});


// Mock environment variables
process.env.DISCORD_TOKEN = "test-token";
process.env.CLIENT_ID = "test-client-id";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 32-byte hex

// Import functions/constants to test AFTER mocks are set up
// agentLoop is the main function to test.
// decrypt is used internally by agentLoop.
// MULTI_MSG_INSTRUCTIONS is used in system prompt construction.
// db is used for database operations.
let agentLoop, decrypt, MULTI_MSG_INSTRUCTIONS, db;


describe("agentLoop Tests", () => {
  let mockMessage;
  let mockAgent;
  let mockAllAgentsInChannel;

  beforeEach(() => {
    jest.resetModules(); // Resets the module registry, needed to re-import index.js
    mockDbRun.mockClear();
    mockDbGet.mockClear();
    mockDbAll.mockClear();
    mockWebhookSend.mockClear();
    mockFetch.mockClear();
    jest.clearAllMocks(); // Clears all other mocks

    // Re-mock 'better-sqlite3' and 'discord.js' for each test to ensure clean state
    jest.mock("better-sqlite3", () => {
      return jest.fn().mockImplementation(() => ({
        prepare: jest.fn().mockImplementation((sql) => {
          if (sql.includes("INSERT INTO messages")) return { run: mockDbRun };
          if (sql.includes("SELECT contextWindow, loopDepth FROM guildSettings")) return { get: mockDbGet };
          if (sql.includes("SELECT * FROM providers WHERE guildId=? AND name=?")) return { get: mockDbGet };
          if (sql.includes("SELECT m.role, m.content, m.agentId, a.name as agentName")) return { all: mockDbAll };
          return { run: mockDbRun, get: mockDbGet, all: mockDbAll };
        }),
        exec: jest.fn(),
        pragma: jest.fn().mockReturnValue([]),
      }));
    });
     jest.mock("discord.js", () => {
      const originalModule = jest.requireActual("discord.js");
      return {
        ...originalModule,
        WebhookClient: jest.fn().mockImplementation(() => ({
          send: mockWebhookSend,
        })),
         // Mock other discord.js components if necessary, e.g., PermissionsBitField
        PermissionsBitField: { Flags: { ManageWebhooks: 'mockManageWebhooksPermission'} }

      };
    });


    process.env.DISCORD_TOKEN = "test-token";
    process.env.CLIENT_ID = "test-client-id";
    process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const mainModule = require("../index.js");
    agentLoop = mainModule.agentLoop;
    decrypt = mainModule.decrypt; // Ensure decrypt is available if needed directly
    MULTI_MSG_INSTRUCTIONS = mainModule.MULTI_MSG_INSTRUCTIONS;
    db = mainModule.db; // The actual db instance from index.js, now mocked

    mockMessage = {
      guild: { id: "test-guild-id", members: { me: { permissionsIn: jest.fn().mockReturnThis(), has: jest.fn().mockReturnValue(true) } } }, // Added for permissions check in agentCreate indirectly via agentClone
      channel: { id: "test-channel-id", sendTyping: jest.fn().mockResolvedValue(null), createWebhook: jest.fn() }, // Added createWebhook for agentCreate
      channelId: "test-channel-id",
      content: "Hello Agent!",
      author: { username: "TestUser", bot: false },
      attachments: new Map(),
      mentions: {},
    };

    mockAgent = {
      id: 1,
      name: "TestAgent",
      model: "test-model",
      providerName: "TestProvider",
      multimodal: 0, // Default to not multimodal
      systemPrompt: "You are a helpful assistant.",
      channelId: "test-channel-id",
      webhookId: "wh-id-1",
      webhookToken: "wh-token-1",
    };

    mockAllAgentsInChannel = [mockAgent];

    // Default DB Mocks
    mockDbGet.mockImplementation((guildId, name) => {
      if (guildId === "test-guild-id" && name === "TestProvider") { // For providerInfo
        return {
          name: "TestProvider",
          url: "http://localhost/llm/chat/completions",
          encryptedKey: "encryptedKeyHex", // Needs to be valid hex for Buffer.from
          iv: "ivHex", // Needs to be valid hex
          authTag: "authTagHex", // Needs to be valid hex
        };
      }
      if (guildId === "test-guild-id") { // For guildSettings
         return { contextWindow: 10, loopDepth: 2 };
      }
      return undefined;
    });
    mockDbAll.mockReturnValue([]); // Default to no recent messages
    mockDbRun.mockReturnValue({ changes: 1 }); // Default for INSERTs

    // Mock decrypt (it's already exported, but we ensure ENCRYPTION_KEY is set)
    // The actual crypto.createDecipheriv will use the mocked ENCRYPTION_KEY.
    // For simplicity, we can also mock the decrypt function itself if needed,
    // but relying on the actual function with a mocked key is more integrated.
    // jest.spyOn(require('../index.js'), 'decrypt').mockReturnValue('decrypted-api-key');


    // Mock LLM fetch response
    const mockLLMStream = new Readable({
      read() {
        this.push('data: {"choices":[{"delta":{"content":"<msg>Hello back!</msg>"}}]}\n\n');
        this.push("data: [DONE]\n\n");
        this.push(null);
      },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      body: mockLLMStream, // ReadableStream.from(mockLLMStream) in a real scenario
      json: async () => ({ data: [] }), // For non-streamed /models calls if any
      text: async () => "Error body text" // For error responses
    });
  });

  describe("chatHistoryForLLM Construction", () => {
    test("should include system prompt and current message", async () => {
      await agentLoop(mockMessage, mockAgent, mockAllAgentsInChannel, 0);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const llmMessages = fetchBody.messages;

      expect(llmMessages[0].role).toBe("system");
      expect(llmMessages[0].content).toBe(`${mockAgent.systemPrompt}\n\n${MULTI_MSG_INSTRUCTIONS}`);
      expect(llmMessages[1].role).toBe("user");
      expect(llmMessages[1].content).toBe(mockMessage.content); // Simple string content
    });

    test("should handle empty system prompt", async () => {
      mockAgent.systemPrompt = "";
      await agentLoop(mockMessage, mockAgent, mockAllAgentsInChannel, 0);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const llmMessages = fetchBody.messages;
      
      expect(llmMessages[0].role).toBe("system");
      expect(llmMessages[0].content).toBe(MULTI_MSG_INSTRUCTIONS); // Only instructions
      expect(llmMessages[1].role).toBe("user");
    });
    
    test("should handle empty system prompt and empty multi-msg instructions (if it were possible)", async () => {
      mockAgent.systemPrompt = "";
      // To test this, we'd need to modify MULTI_MSG_INSTRUCTIONS for the test's scope
      // For now, assume MULTI_MSG_INSTRUCTIONS is always present.
      // If MULTI_MSG_INSTRUCTIONS was also empty, there should be no system message.
      // This would require temporarily changing the imported constant or injecting it.
      // For simplicity, this specific sub-case (both empty) is noted but not fully tested here without more complex mocking.
      const originalMultiMsg = MULTI_MSG_INSTRUCTIONS; // Save original
      const tempModule = require('../index.js');
      tempModule.MULTI_MSG_INSTRUCTIONS = ""; // Temporarily modify for this test

      await agentLoop(mockMessage, mockAgent, mockAllAgentsInChannel, 0);
      
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const llmMessages = fetchBody.messages;

      // Expect no system message if both agent's prompt and global instructions are empty
      expect(llmMessages.find(m => m.role === "system")).toBeUndefined();
      expect(llmMessages[0].role).toBe("user");

      tempModule.MULTI_MSG_INSTRUCTIONS = originalMultiMsg; // Restore
    });

    test("should correctly format historical messages", async () => {
      const historicalMessages = [
        // User message
        { role: "user", content: '<msg from="AnotherUser">Old message</msg>', agentId: mockAgent.id + 1, name: "AnotherUser" },
        // This agent's own past assistant message
        { role: "assistant", content: "<msg>My own old reply</msg>", agentId: mockAgent.id, name: mockAgent.name },
        // Another agent's assistant message (treated as user input)
        { role: "assistant", content: '<msg from="OtherAgent">Other agent reply</msg>', agentId: mockAgent.id + 2, name: "OtherAgent" },
         // A multi-part message from this agent (should be stripped and combined if consecutive)
        { role: "assistant", content: "<msg>Part 1 of my reply</msg>", agentId: mockAgent.id, name: mockAgent.name },
        { role: "assistant", content: "<msg>Part 2 of my reply</msg>", agentId: mockAgent.id, name: mockAgent.name },
      ];
      mockDbAll.mockReturnValue(historicalMessages); // Mock DB to return these

      await agentLoop(mockMessage, mockAgent, mockAllAgentsInChannel, 0);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const llmMessages = fetchBody.messages;

      // System prompt
      expect(llmMessages[0].role).toBe("system");

      // Historical messages
      expect(llmMessages[1].role).toBe("user");
      expect(llmMessages[1].content).toBe('<msg from="AnotherUser">Old message</msg>');

      expect(llmMessages[2].role).toBe("assistant");
      expect(llmMessages[2].content).toBe("My own old reply\nPart 1 of my reply\nPart 2 of my reply"); // Own messages stripped and merged

      expect(llmMessages[3].role).toBe("user");
      expect(llmMessages[3].content).toBe('<msg from="OtherAgent">Other agent reply</msg>');
      
      // Current message
      expect(llmMessages[4].role).toBe("user");
      expect(llmMessages[4].content).toBe(mockMessage.content);
    });

    test("should handle multimodal content with image attachment", async () => {
      mockAgent.multimodal = 1;
      const mockImageAttachment = {
        id: "img1",
        url: "http://localhost/image.png",
        contentType: "image/png",
        name: "image.png"
      };
      mockMessage.attachments = new Map([["img1", mockImageAttachment]]);
      mockMessage.content = "Check out this image!";

      await agentLoop(mockMessage, mockAgent, mockAllAgentsInChannel, 0);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const llmMessages = fetchBody.messages;

      const userMessageContent = llmMessages.find(m => m.role === "user" && Array.isArray(m.content)).content;
      expect(userMessageContent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Check out this image!" }),
          expect.objectContaining({ type: "image_url", image_url: { url: "http://localhost/image.png" } }),
        ])
      );
    });
    
    test("should handle multimodal content with text attachment", async () => {
      mockAgent.multimodal = 1; // or 0, text attachments are processed regardless for now
      const mockTextAttachment = {
        id: "txt1",
        url: "http://localhost/file.txt",
        contentType: "text/plain",
        name: "file.txt"
      };
      mockMessage.attachments = new Map([["txt1", mockTextAttachment]]);
      mockMessage.content = "Info in attachment.";

      // Mock fetch for the text attachment itself
      mockFetch.mockImplementation(async (url) => {
        if (url === "http://localhost/file.txt") {
          return { ok: true, text: async () => "This is text from attachment." };
        }
        // Fallback to the LLM stream mock for other fetches
        const mockLLMStream = new Readable({ read() { this.push('data: {"choices":[{"delta":{"content":"<msg>Got it.</msg>"}}]}\n\n'); this.push("data: [DONE]\n\n"); this.push(null); } });
        return { ok: true, status: 200, statusText: "OK", body: mockLLMStream, json: async () => ({data:[]}), text: async () => "" };
      });

      await agentLoop(mockMessage, mockAgent, mockAllAgentsInChannel, 0);

      // Fetch call for LLM is the second one in this case (first is for attachment)
      expect(mockFetch).toHaveBeenCalledTimes(2); 
      const fetchBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const llmMessages = fetchBody.messages;
      
      const userMessageContent = llmMessages.find(m => m.role === "user" && Array.isArray(m.content)).content;
      expect(userMessageContent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Info in attachment." }),
          expect.objectContaining({ type: "text", text: 'Content from attachment "file.txt":\nThis is text from attachment.' }),
        ])
      );

      // Also check the content stored in DB for the user message
      const dbUserMessageInsert = mockDbRun.mock.calls.find(call => call[1] === 'user')[2]; // Third arg to run() is the content
      expect(dbUserMessageInsert).toContain("Info in attachment.");
      expect(dbUserMessageInsert).toContain('Content from attachment "file.txt":\nThis is text from attachment.');

    });
  });

  // --- Test Stream Parsing ---
  // The stream parsing logic is inside `agentLoop` and tied to `lineReader` events.
  // To test this in isolation, we would ideally extract the event handlers.
  // For now, we'll test it more integratedly by checking `webhookClient.send` calls.

  describe("LLM Stream Parsing and Webhook Sending", () => {
    test("should correctly parse stream and send messages via webhook", async () => {
      // LLM mock already set up in beforeEach to send:
      // 'data: {"choices":[{"delta":{"content":"<msg>Hello back!</msg>"}}]}\n\n'
      // 'data: [DONE]\n\n'
      await agentLoop(mockMessage, mockAgent, mockAllAgentsInChannel, 0);

      // Wait for stream processing (it's async due to readline events)
      // A short delay or a more sophisticated mechanism might be needed if tests are flaky.
      await new Promise(resolve => setTimeout(resolve, 0)); // Allow event loop to process

      expect(mockWebhookSend).toHaveBeenCalledTimes(1);
      expect(mockWebhookSend).toHaveBeenCalledWith({ content: "Hello back!" });

      // Verify message stored in DB
      const dbAssistantMessageInsert = mockDbRun.mock.calls.find(call => call[1] === 'assistant')[2];
      expect(dbAssistantMessageInsert).toBe("<msg>Hello back!</msg>");
    });

    test("should handle multiple <msg> tags in stream", async () => {
      const streamChunks = [
        'data: {"choices":[{"delta":{"content":"<msg>First part.</msg>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"<msg>Second part."}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const mockLLMStream = new Readable({
        read() { streamChunks.forEach(chunk => this.push(chunk)); this.push(null); },
      });
      mockFetch.mockResolvedValue({ ok: true, body: mockLLMStream, status:200, statusText:"OK" });

      await agentLoop(mockMessage, mockAgent, mockAllAgentsInChannel, 0);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockWebhookSend).toHaveBeenCalledTimes(2);
      expect(mockWebhookSend).nthCalledWith(1, { content: "First part." });
      expect(mockWebhookSend).nthCalledWith(2, { content: "Second part." });
    });

    test("should ignore <think> tags and their content", async () => {
      const streamChunks = [
        'data: {"choices":[{"delta":{"content":"<think>Hmm...</think><msg>Visible.</msg>"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
       const mockLLMStream = new Readable({
        read() { streamChunks.forEach(chunk => this.push(chunk)); this.push(null); },
      });
      mockFetch.mockResolvedValue({ ok: true, body: mockLLMStream, status:200, statusText:"OK" });
      
      await agentLoop(mockMessage, mockAgent, mockAllAgentsInChannel, 0);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockWebhookSend).toHaveBeenCalledTimes(1);
      expect(mockWebhookSend).toHaveBeenCalledWith({ content: "Visible." });
    });

    test("should handle leftover buffer content not ending in </msg> with a warning", async () => {
        const streamChunks = [
            'data: {"choices":[{"delta":{"content":"<msg>Complete message.</msg>Incomplete part..."}}]}\n\n',
            'data: [DONE]\n\n',
        ];
        const mockLLMStream = new Readable({
            read() { streamChunks.forEach(chunk => this.push(chunk)); this.push(null); },
        });
        mockFetch.mockResolvedValue({ ok: true, body: mockLLMStream, status:200, statusText:"OK" });

        await agentLoop(mockMessage, mockAgent, mockAllAgentsInChannel, 0);
        await new Promise(resolve => setTimeout(resolve, 0)); // Allow event loop to process

        expect(mockWebhookSend).toHaveBeenCalledTimes(2); // One for complete, one for leftover
        expect(mockWebhookSend).nthCalledWith(1, { content: "Complete message." });
        expect(mockWebhookSend).nthCalledWith(2, { content: "Incomplete part...\n\n---\n*Warning: LLM did not correctly format this part of the message. It should have been wrapped in `<msg>` tags.*" });
        
        // Check DB storage for the leftover part
        const assistantMessagesInDb = mockDbRun.mock.calls.filter(call => call[1] === 'assistant');
        expect(assistantMessagesInDb[1][2]).toBe("<msg>Incomplete part...</msg>"); // Stored with <msg> tags
    });
  });
});
