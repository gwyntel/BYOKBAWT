// Test file for database interactions
const mockExec = jest.fn();
const mockPrepareRun = jest.fn();
const mockPrepareAll = jest.fn();
const mockPrepareGet = jest.fn(); // Added for other potential uses

// Mock the main 'better-sqlite3' module
jest.mock("better-sqlite3", () => {
  return jest.fn().mockImplementation(() => {
    return {
      exec: mockExec,
      prepare: jest.fn().mockImplementation((sql) => {
        // console.log(`Mock prepare called with SQL: ${sql}`); // For debugging
        return {
          run: mockPrepareRun,
          all: mockPrepareAll,
          get: mockPrepareGet,
        };
      }),
      pragma: jest.fn().mockReturnValue([]),
    };
  });
});

// Mock crypto for encryption/decryption parts
const MOCK_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.ENCRYPTION_KEY = MOCK_ENCRYPTION_KEY;
process.env.DISCORD_TOKEN = "test-token";
process.env.CLIENT_ID = "test-client-id";

// We need to import the functions to test AFTER setting up mocks
let handleProviderCmd;

describe("Database Initialization and Migrations", () => {
  beforeEach(() => {
    jest.resetModules(); // This is key to re-importing index.js cleanly for each test
    mockExec.mockClear();
    mockPrepareRun.mockClear();
    mockPrepareAll.mockClear();
    mockPrepareGet.mockClear();
    // Re-mock 'better-sqlite3' specifically for this describe block if needed, or rely on global mock
     jest.mock("better-sqlite3", () => {
      return jest.fn().mockImplementation(() => {
        return {
          exec: mockExec,
          prepare: jest.fn().mockImplementation((sql) => {
            return {
              run: mockPrepareRun,
              all: mockPrepareAll,
              get: mockPrepareGet,
            };
          }),
          pragma: jest.fn().mockReturnValue([{name: 'some_column'}]), // ensure pragma returns something
        };
      });
    });
    process.env.ENCRYPTION_KEY = MOCK_ENCRYPTION_KEY;
    process.env.DISCORD_TOKEN = "test-token";
    process.env.CLIENT_ID = "test-client-id";
    // Import index.js where DB setup occurs.
    // We also get the exported functions here.
    const mainModule = require("../index.js");
    handleProviderCmd = mainModule.handleProviderCmd;


  });

  test("should execute CREATE TABLE statements on startup", () => {
    expect(mockExec).toHaveBeenCalledTimes(1);
    const execCallArg = mockExec.mock.calls[0][0];
    expect(execCallArg).toContain("CREATE TABLE IF NOT EXISTS providers");
    expect(execCallArg).toContain("CREATE TABLE IF NOT EXISTS agents");
    expect(execCallArg).toContain("CREATE TABLE IF NOT EXISTS messages");
    expect(execCallArg).toContain("CREATE TABLE IF NOT EXISTS guildSettings");
    expect(execCallArg).toContain("CREATE TABLE IF NOT EXISTS yap_settings");
  });

  test("should attempt ALTER TABLE statements for agents and handle 'duplicate column' errors", () => {
    const prepareMock = require("better-sqlite3")().prepare;
    // Reset specific mock for this test if necessary, or ensure it's clean
    mockPrepareRun.mockReset();


    // Simulate "duplicate column name" for the first ALTER TABLE
    mockPrepareRun.mockImplementationOnce(() => { throw { message: "duplicate column name: linkedToAgentId" }; });
    // Simulate success for the second ALTER TABLE
    mockPrepareRun.mockImplementationOnce(() => ({ changes: 1 }));
    // Simulate "already exists" for the third ALTER TABLE
    mockPrepareRun.mockImplementationOnce(() => { throw { message: "column avatarData already exists" }; });
    // Simulate success for the fourth ALTER TABLE
    mockPrepareRun.mockImplementationOnce(() => ({ changes: 1 }));

    // Re-run the setup logic by re-requiring (if not done in beforeEach already in a way that works for this)
    // For this test, the beforeEach already runs index.js, which runs the migrations.
    // We just need to ensure the mockPrepareRun sequence is set before index.js runs.
    // The current beforeEach might be problematic if it runs index.js before we can set specific mock behaviors for ALTER.
    // Solution: The require("../index.js") in beforeEach should be fine as long as the mocks are configured before it.
    // Let's ensure the prepare mock is consistently returning our mock statement object.
    
    // The `prepare` calls happen during the require('../index.js') in `beforeEach`.
    // We need to check the calls made to the `prepare` mock.
    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining("ALTER TABLE agents ADD COLUMN linkedToAgentId"));
    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining("ALTER TABLE agents ADD COLUMN isSourceForLink"));
    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining("ALTER TABLE agents ADD COLUMN avatarData TEXT"));
    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining("ALTER TABLE agents ADD COLUMN avatarMimeType TEXT"));

    // mockPrepareRun is called by the ALTER TABLE statements in index.js
    // It should be called 4 times based on the current structure.
    expect(mockPrepareRun).toHaveBeenCalledTimes(4);
  });

  test("pragma for agents table should be called for avatarURL check", () => {
     const pragmaMock = require("better-sqlite3")().pragma;
     expect(pragmaMock).toHaveBeenCalledWith('table_info(agents)');
  });
});

describe("handleProviderCmd Tests", () => {
  let mockInteraction;

  beforeEach(() => {
    jest.resetModules(); // Ensure a clean state for modules
    // Setup basic mocks for better-sqlite3
    mockExec.mockClear();
    mockPrepareRun.mockClear();
    mockPrepareAll.mockClear();
    mockPrepareGet.mockClear();

    jest.mock("better-sqlite3", () => {
      return jest.fn().mockImplementation(() => ({
        exec: mockExec,
        prepare: jest.fn().mockImplementation((sql) => ({
          run: mockPrepareRun,
          all: mockPrepareAll,
          get: mockPrepareGet,
        })),
        pragma: jest.fn().mockReturnValue([]),
      }));
    });
    
    process.env.ENCRYPTION_KEY = MOCK_ENCRYPTION_KEY;
    process.env.DISCORD_TOKEN = "test-token";
    process.env.CLIENT_ID = "test-client-id";

    // Import the specific function to test
    const mainModule = require("../index.js");
    handleProviderCmd = mainModule.handleProviderCmd;


    mockInteraction = {
      options: {
        getSubcommand: jest.fn(),
        getString: jest.fn(),
      },
      guildId: "test-guild-id",
      reply: jest.fn().mockReturnThis(), // Make reply chainable or return a Promise
      followUp: jest.fn().mockReturnThis(),
      deferReply: jest.fn().mockReturnThis(),
    };
  });

  describe("provider add", () => {
    beforeEach(() => {
        mockInteraction.options.getSubcommand.mockReturnValue("add");
    });

    test("should add a new provider successfully", async () => {
      mockInteraction.options.getString.mockImplementation((optionName) => {
        switch (optionName) {
          case "name": return "TestProvider";
          case "url": return "http://localhost/api";
          case "key": return "test-api-key";
          default: return null;
        }
      });
      mockPrepareRun.mockReturnValue({ changes: 1 }); // Simulate successful insert

      await handleProviderCmd(mockInteraction);

      const prepareMock = require("better-sqlite3")().prepare;
      expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO providers"));
      expect(mockPrepareRun).toHaveBeenCalledWith(
        "test-guild-id",
        "TestProvider",
        "http://localhost/api",
        expect.any(String), // encryptedKey
        expect.any(String), // iv
        expect.any(String)  // authTag
      );
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: "Provider **TestProvider** added.",
        ephemeral: true,
      });
    });

    test("should handle SQLITE_CONSTRAINT_UNIQUE error when adding a duplicate provider", async () => {
      mockInteraction.options.getString.mockImplementation((optionName) => {
        switch (optionName) {
          case "name": return "ExistingProvider";
          case "url": return "http://localhost/api";
          case "key": return "test-api-key";
          default: return null;
        }
      });
      // Simulate unique constraint violation
      mockPrepareRun.mockImplementation(() => {
        throw { code: "SQLITE_CONSTRAINT_UNIQUE" };
      });

      await handleProviderCmd(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: `Provider "ExistingProvider" already exists in this server.`,
        ephemeral: true,
      });
    });
  });

  describe("provider list", () => {
     beforeEach(() => {
        mockInteraction.options.getSubcommand.mockReturnValue("list");
    });

    test("should list configured providers", async () => {
      const mockProviders = [
        { name: "Provider1", url: "http://url1.com" },
        { name: "Provider2", url: "http://url2.com" },
      ];
      mockPrepareAll.mockReturnValue(mockProviders);

      await handleProviderCmd(mockInteraction);
      
      const prepareMock = require("better-sqlite3")().prepare;
      expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining("SELECT name, url FROM providers"));
      expect(mockPrepareAll).toHaveBeenCalledWith("test-guild-id");
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: "Configured providers for this server:\n- **Provider1**: http://url1.com\n- **Provider2**: http://url2.com",
        ephemeral: true,
      });
    });

    test("should show a message if no providers are configured", async () => {
      mockPrepareAll.mockReturnValue([]); // Simulate no providers found

      await handleProviderCmd(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: "No providers configured for this server. Add one with `/provider add`.",
        ephemeral: true,
      });
    });
  });
});
