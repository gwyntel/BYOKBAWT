// Test file for command handlers
const mockDbPrepareRun = jest.fn();

jest.mock("better-sqlite3", () => {
  return jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockImplementation((sql) => ({
      run: mockDbPrepareRun,
      // Add other methods like all, get if needed by other functions
    })),
    exec: jest.fn(), // Mock exec if startup sequence in index.js needs it
    pragma: jest.fn().mockReturnValue([]), // Default mock for pragma
  }));
});

// Mock environment variables
process.env.DISCORD_TOKEN = "test-token";
process.env.CLIENT_ID = "test-client-id";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Import functions to test after mocks are set up
const { handleHelp, handleContextWindow, handleLoopDepth } = require("../index.js");

describe("Command Handler Tests", () => {
  let mockInteraction;

  beforeEach(() => {
    // Reset mocks for each test
    mockDbPrepareRun.mockClear();
    jest.clearAllMocks(); // Clears all mocks including the top-level better-sqlite3

    // Re-initialize environment variables if cleared by jest.clearAllMocks()
    process.env.DISCORD_TOKEN = "test-token";
    process.env.CLIENT_ID = "test-client-id";
    process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";


    mockInteraction = {
      options: {
        getInteger: jest.fn(),
        getString: jest.fn(), // Add if other commands use it
        getBoolean: jest.fn(), // Add if other commands use it
        getChannel: jest.fn(), // Add if other commands use it
        getAttachment: jest.fn(), // Add if other commands use it
        getSubcommand: jest.fn(), // Add if other commands use it
      },
      guildId: "test-guild-id",
      channel: { id: "test-channel-id"}, // Mock channel if used
      reply: jest.fn().mockReturnThis(),
      followUp: jest.fn().mockReturnThis(), // For commands that defer
      deferReply: jest.fn().mockReturnThis(), // For commands that defer
    };

    // Reset better-sqlite3 mocks specifically if they were altered in a test
    // This ensures that the mockDbPrepareRun is the one used by the Database instance.
     jest.mock("better-sqlite3", () => {
      return jest.fn().mockImplementation(() => ({
        prepare: jest.fn().mockImplementation((sql) => ({
          run: mockDbPrepareRun,
        })),
        exec: jest.fn(), 
        pragma: jest.fn().mockReturnValue([]), 
      }));
    });
  });

  describe("handleHelp", () => {
    it("should reply with help text and ephemeral true", async () => {
      await handleHelp(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledTimes(1);
      const replyOptions = mockInteraction.reply.mock.calls[0][0];
      expect(replyOptions.content).toContain("Bot Help");
      expect(replyOptions.content).toContain("/agent create");
      expect(replyOptions.content).toContain("/provider add");
      // Add more specific checks for key phrases if necessary
      expect(replyOptions.ephemeral).toBe(true);
    });
  });

  describe("handleContextWindow", () => {
    it("should update context window size and reply", async () => {
      const sampleSize = 15;
      mockInteraction.options.getInteger.mockReturnValue(sampleSize);

      await handleContextWindow(mockInteraction);

      const prepareMock = require("better-sqlite3")().prepare;
      expect(prepareMock).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO guildSettings (guildId,contextWindow)")
      );
      expect(mockDbPrepareRun).toHaveBeenCalledWith(mockInteraction.guildId, sampleSize);
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: `Context window set to ${sampleSize} messages.`,
        ephemeral: true,
      });
    });
  });

  describe("handleLoopDepth", () => {
    it("should update loop depth and reply", async () => {
      const sampleDepth = 3;
      mockInteraction.options.getInteger.mockReturnValue(sampleDepth);

      await handleLoopDepth(mockInteraction);
      
      const prepareMock = require("better-sqlite3")().prepare;
      expect(prepareMock).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO guildSettings (guildId,loopDepth)")
      );
      expect(mockDbPrepareRun).toHaveBeenCalledWith(mockInteraction.guildId, sampleDepth);
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: `Agent-to-agent reply loop depth set to ${sampleDepth}`,
        ephemeral: true,
      });
    });
  });
});
