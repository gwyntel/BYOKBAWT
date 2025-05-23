require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
  WebhookClient
} = require("discord.js");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const readline = require("readline");
const path = require("path");
const { Readable } = require("stream");

const MULTI_MSG_INSTRUCTIONS =
  "**Multi-Message Formatting Instructions:**\n\n" +
  "Please format your responses using the following guidelines:\n\n" +
  "1. Wrap your message responses in `<msg>content</msg>` tags.\n" +
  "2. Instead of using new lines to separate thoughts, paragraphs, or ideas, use multiple `<msg>` tags.\n" +
  "3. Each `<msg>` tag will be displayed as a separate message in Discord.\n" +
  "4. You may use Discord markdown formatting within your replies (bold, italic, code blocks, etc.).\n\n" +
  "Example:\n" +
  "```\n" +
  "<msg>Hello! I've analyzed your request.</msg>\n" +
  "<msg>Here's what I found:\n- Point 1\n- Point 2</msg>\n" +
  "<msg>Let me know if you need anything else!</msg>\n" +
  "```\n\n" +
  "This will appear as three separate messages in Discord.";

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // 32-byte hex
if (!TOKEN || !CLIENT_ID || !ENCRYPTION_KEY) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID or ENCRYPTION_KEY");
  process.exit(1);
}
if (Buffer.from(ENCRYPTION_KEY, "hex").length !== 32) {
  console.error("ENCRYPTION_KEY must be a 32-byte key (64 hex characters).");
  process.exit(1);
}

// --- Database setup ---
const db = new Database("bot.db");
db.exec(`
CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  encryptedKey TEXT NOT NULL,
  iv TEXT NOT NULL,
  authTag TEXT NOT NULL,
  UNIQUE(guildId,name)
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  providerName TEXT NOT NULL,
  multimodal INTEGER NOT NULL,
  systemPrompt TEXT NOT NULL,
  avatarMimeType TEXT, -- Stores the MIME type of the avatar, e.g., image/png
  avatarData TEXT,     -- Stores base64 encoded avatar image data
  channelId TEXT NOT NULL,
  webhookId TEXT NOT NULL,
  webhookToken TEXT NOT NULL,
  linkedToAgentId INTEGER, -- ID of the agent this one is cloned from and linked to
  isSourceForLink INTEGER NOT NULL DEFAULT 0, -- 1 if this agent is a source for linked clones
  UNIQUE(guildId,name,channelId),
  FOREIGN KEY(linkedToAgentId) REFERENCES agents(id) ON DELETE SET NULL -- If source is deleted, unlink clones
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  author TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(agentId) REFERENCES agents(id)
);
CREATE TABLE IF NOT EXISTS guildSettings (
  guildId TEXT PRIMARY KEY,
  contextWindow INTEGER NOT NULL DEFAULT 10,
  loopDepth INTEGER NOT NULL DEFAULT 2 -- Added loopDepth here during initial setup review
);
CREATE TABLE IF NOT EXISTS yap_settings (
  agentId INTEGER NOT NULL,
  channelId TEXT NOT NULL,
  isEnabled INTEGER NOT NULL DEFAULT 0, -- 0 for false, 1 for true
  PRIMARY KEY (agentId, channelId),
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
);
`);

// --- Ensure loopDepth column exists in guildSettings (already added to CREATE TABLE) ---
// try {
//   db.prepare(
//     "ALTER TABLE guildSettings ADD COLUMN loopDepth INTEGER NOT NULL DEFAULT 2"
//   ).run();
// } catch (e) {
//   // Ignore error if column already exists
// }

// --- Ensure linkedToAgentId and isSourceForLink columns exist in agents table ---
try {
  db.prepare("ALTER TABLE agents ADD COLUMN linkedToAgentId INTEGER REFERENCES agents(id) ON DELETE SET NULL").run();
  console.log("Successfully added linkedToAgentId column to agents table.");
} catch (e) {
  if (e.message.includes("duplicate column name") || e.message.includes("already exists")) { /* Column already exists, ignore */ } 
  else { console.error("Error adding linkedToAgentId column to agents table:", e.message); }
}
try {
  db.prepare("ALTER TABLE agents ADD COLUMN isSourceForLink INTEGER NOT NULL DEFAULT 0").run();
  console.log("Successfully added isSourceForLink column to agents table.");
} catch (e) {
  if (e.message.includes("duplicate column name") || e.message.includes("already exists")) { /* Column already exists, ignore */ }
  else { console.error("Error adding isSourceForLink column to agents table:", e.message); }
}

// --- Ensure avatarData and avatarMimeType columns exist and handle old avatarURL column ---
try {
  // Attempt to add new columns first
  try {
    db.prepare("ALTER TABLE agents ADD COLUMN avatarData TEXT").run();
    console.log("Successfully added avatarData column to agents table.");
  } catch (e) {
    if (!e.message.includes("duplicate column name") && !e.message.includes("already exists")) {
      console.error("Error adding avatarData column to agents table:", e.message); throw e;
    }
  }
  try {
    db.prepare("ALTER TABLE agents ADD COLUMN avatarMimeType TEXT").run();
    console.log("Successfully added avatarMimeType column to agents table.");
  } catch (e) {
    if (!e.message.includes("duplicate column name") && !e.message.includes("already exists")) {
      console.error("Error adding avatarMimeType column to agents table:", e.message); throw e;
    }
  }

  const columns = db.pragma('table_info(agents)');
  const avatarURLExists = columns.some(col => col.name === 'avatarURL');
  if (avatarURLExists) {
    // Column will be ignored by new code.
  }

} catch (e) {
  console.error("Error during avatar column migration for agents table:", e.message);
}


// --- AES-GCM encryption helpers ---
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(ENCRYPTION_KEY, "hex"),
    iv
  );
  let enc = cipher.update(text, "utf8", "hex");
  enc += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return { iv: iv.toString("hex"), encrypted: enc, authTag };
}
function decrypt(encrypted, ivHex, authTagHex) {
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(ENCRYPTION_KEY, "hex"),
    iv
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  let dec = decipher.update(encrypted, "hex", "utf8");
  dec += decipher.final("utf8");
  return dec;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("agent")
      .setDescription("Manage AI agents")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Create an AI agent")
          .addStringOption((o) =>
            o.setName("name").setDescription("Agent name").setRequired(true)
          )
          .addStringOption((o) =>
            o.setName("model").setDescription("Model ID").setRequired(true)
          )
          .addStringOption((o) =>
            o
              .setName("provider")
              .setDescription("Provider name")
              .setRequired(true)
          )
          .addBooleanOption((o) =>
            o
              .setName("multimodal")
              .setDescription("Vision enabled?")
              .setRequired(true)
          )
          .addAttachmentOption((o) =>
            o
              .setName("sysprompt")
              .setDescription("System prompt (.md/.txt)")
              .setRequired(true)
          )
          .addAttachmentOption((o) =>
            o.setName("avatar").setDescription("Avatar image")
          )
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Target channel")
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("List agents in a channel")
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Target channel")
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete an AI agent")
          .addStringOption((o) =>
            o.setName("name").setDescription("Agent name").setRequired(true)
          )
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Target channel")
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("edit")
          .setDescription(
            "Edit an AI agent in the current channel by name"
          )
          .addStringOption((o) =>
            o.setName("name").setDescription("Agent name").setRequired(true)
          )
          .addStringOption((o) =>
            o.setName("model").setDescription("New model").setRequired(false)
          )
          .addStringOption((o) =>
            o
              .setName("provider")
              .setDescription("New provider")
              .setRequired(false)
          )
          .addBooleanOption((o) =>
            o
              .setName("multimodal")
              .setDescription("Vision enabled?")
              .setRequired(false)
          )
          .addAttachmentOption((o) =>
            o
              .setName("sysprompt")
              .setDescription("System prompt (.md/.txt)")
          )
          .addAttachmentOption((o) =>
            o.setName("avatar").setDescription("Avatar image")
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("refresh")
          .setDescription(
            "Recreate the webhook for an agent in this channel"
          )
          .addStringOption((o) =>
            o.setName("name").setDescription("Agent name").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("clone")
          .setDescription(
            "Clone an existing agent's settings to another channel"
          )
          .addStringOption((o) =>
            o
              .setName("original-agent-name")
              .setDescription("Name of the agent to clone")
              .setRequired(true)
          )
          .addChannelOption((o) =>
            o
              .setName("target-channel")
              .setDescription("Channel to clone the agent to")
              .setRequired(true)
          )
          .addStringOption((o) =>
            o
              .setName("new-agent-name")
              .setDescription(
                "Optional new name for the cloned agent in the target channel"
              )
              .setRequired(false)
          )
          .addBooleanOption((o) =>
            o
              .setName("linked")
              .setDescription(
                "Link this clone to the original? (Edits to original will propagate, default: false)"
              )
              .setRequired(false)
          )
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("provider")
      .setDescription("Manage LLM providers")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Add a provider")
          .addStringOption((o) =>
            o.setName("name").setDescription("Provider name").setRequired(true)
          )
          .addStringOption((o) =>
            o
              .setName("url")
              .setDescription("Chat completions URL")
              .setRequired(true)
          )
          .addStringOption((o) =>
            o.setName("key").setDescription("API key").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete a provider")
          .addStringOption((o) =>
            o
              .setName("name")
              .setDescription("Provider name")
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("List all configured providers for this server")
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("contextwindow")
      .setDescription("Set context window size")
      .addIntegerOption((o) =>
        o
          .setName("size")
          .setDescription("Number of messages")
          .setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("loopdepth")
      .setDescription("Set agent-to-agent reply loop depth")
      .addIntegerOption((o) =>
        o
          .setName("depth")
          .setDescription("Max agent reply turns per message")
          .setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("clearcontext")
      .setDescription("Clear conversation context")
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Target channel")
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("models")
      .setDescription("List available models")
      .addStringOption((o) =>
        o.setName("provider").setDescription("Provider name")
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Show help for all commands")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("yap")
      .setDescription("Configure channel auto-reply for an agent.")
      .addStringOption((o) =>
        o
          .setName("agent")
          .setDescription("Name of the agent to configure.")
          .setRequired(true)
      )
      .addBooleanOption((o) =>
        o
          .setName("enabled")
          .setDescription("Enable or disable auto-reply for this agent.")
          .setRequired(true)
      )
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription(
            "The channel where this agent will auto-reply."
          )
          .setRequired(true)
      )
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("Slash commands deployed");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    switch (interaction.commandName) {
      case "agent":
        await handleAgentCmd(interaction);
        break;
      case "provider":
        await handleProviderCmd(interaction);
        break;
      case "contextwindow":
        await handleContextWindow(interaction);
        break;
      case "loopdepth":
        await handleLoopDepth(interaction);
        break;
      case "clearcontext":
        await handleClearContext(interaction);
        break;
      case "models":
        await handleModels(interaction);
        break;
      case "help":
        await handleHelp(interaction);
        break;
      case "yap":
        await handleYapCommand(interaction);
        break;
    }
  } catch (err) {
    console.error("Unhandled error in interactionCreate:", err);
    const msg = "An unexpected error occurred. Please try again later.";
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: msg, ephemeral: true });
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    } catch (replyError) {
      console.error(
        "Failed to send error reply to interaction:",
        replyError.message
      );
      if (replyError.code === 10062) { // DiscordAPIError[10062]: Unknown interaction
        console.warn(
          "Original interaction likely expired before an error message could be sent."
        );
      }
    }
  }
});

// --- /help command ---
async function handleHelp(interaction) {
  // This command is quick, no defer needed.
  const helpText = `
**🤖 Bot Help**

\`/agent create\` [Name] [Model] [Provider] [Multimodal Y/N] [SysPrompt .md/.txt] [Avatar] [Channel]  
Create a new AI agent (webhook). Avatar & channel are optional (channel defaults to current).

\`/agent list\` [Channel]  
List agents in a channel (default: current).

\`/agent delete\` [Name] [Channel]  
Delete an agent by name in a channel (default: current).

\`/agent edit\` [Name] [Model?] [Provider?] [Multimodal Y/N?] [SysPrompt .md/.txt?] [Avatar?]  
Modify an existing agent’s settings in the **current channel**. Optional fields will retain their current value if not provided.
If this agent is a source for linked clones, changes to model, provider, system prompt, and avatar will propagate to its clones.

\`/agent refresh\` [Name]  
Recreate the webhook for an agent in this channel.

\`/agent clone\` [Original Agent Name] [Target Channel] [New Agent Name?]
Clone an existing agent's settings from any channel in this server to the target channel. If New Agent Name is not provided, the original name is used.
If \`linked\` is true, some edits to the original agent (like model, provider, system prompt, avatar) will also apply to this clone.

\`/provider add\` [Name] [Chat Completions URL] [API Key]  
Add a new LLM provider (per‐server).

\`/provider delete\` [Name]  
Remove a provider.

\`/provider list\`
List all configured providers for this server.

\`/models\` [Provider]  
List available models from a provider.

\`/contextwindow\` [Size]  
Set how many messages to include in context.

\`/loopdepth\` [Depth]  
Set how many agent-to-agent reply turns are allowed per message.

\`/clearcontext\` [Channel]  
Clear stored messages for all agents in a channel (default: current).

---

To talk to an agent:
• Reply to one of its messages,  
• Prefix your message with \`@AgentName\`, or  
• Mention the agent's name as a word in your message.

All LLM replies will be broken into <msg>…</msg> chunks automatically and sent as separate messages.
`;
  return interaction.reply({ content: helpText, ephemeral: true });
}

// --- /yap command ---
async function handleYapCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const agentName = interaction.options.getString("agent");
  const enabled = interaction.options.getBoolean("enabled");
  const targetChannel = interaction.options.getChannel("channel");

  if (!interaction.guildId) {
    return interaction.followUp({ content: "This command can only be used in a server.", ephemeral: true });
  }

  // Find the agent by name in the current guild.
  // Note: Agent names are unique per guild *and* channelId in the `agents` table.
  // However, a user might refer to an agent by its name generally within the guild.
  // For /yap, we need to ensure the agent exists. The channel for yap is specified in the command.
  const agent = db
    .prepare(
      "SELECT id FROM agents WHERE guildId = ? AND name = ? LIMIT 1"
    )
    .get(interaction.guildId, agentName);

  if (!agent) {
    return interaction.followUp({
      content: `Agent "${agentName}" not found in this server. Agent names are case-sensitive.`,
      ephemeral: true
    });
  }

  try {
    db.prepare(
      `INSERT INTO yap_settings (agentId, channelId, isEnabled)
       VALUES (?, ?, ?)
       ON CONFLICT(agentId, channelId) DO UPDATE SET
         isEnabled = excluded.isEnabled`
    ).run(agent.id, targetChannel.id, enabled ? 1 : 0);

    const status = enabled ? "enabled" : "disabled";
    return interaction.followUp({
      content: `Auto-reply for agent **${agentName}** in <#${targetChannel.id}> has been **${status}**.`,
      ephemeral: true
    });
  } catch (dbError) {
    console.error("Error updating yap_settings:", dbError);
    return interaction.followUp({
      content: `An error occurred while updating auto-reply settings. (${dbError.message})`,
      ephemeral: true
    });
  }
}


// --- /loopdepth command ---
async function handleLoopDepth(interaction) {
  // This command is quick, no defer needed.
  const depth = interaction.options.getInteger("depth");
  db.prepare(
    `INSERT INTO guildSettings (guildId,loopDepth)
     VALUES (?,?)
     ON CONFLICT(guildId) DO UPDATE SET
       loopDepth=excluded.loopDepth`
  ).run(interaction.guildId, depth);
  return interaction.reply({
    content: `Agent-to-agent reply loop depth set to ${depth}`,
    ephemeral: true
  });
}

async function agentClone(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const originalAgentName = interaction.options.getString("original-agent-name");
  const targetChannel = interaction.options.getChannel("target-channel");
  const newAgentNameInput = interaction.options.getString("new-agent-name");
  const linked = interaction.options.getBoolean("linked") || false;

  // Fetch the original agent. It can be in any channel within the guild.
  const originalAgent = db
    .prepare(
      "SELECT * FROM agents WHERE guildId=? AND name=?"
    )
    .get(interaction.guildId, originalAgentName);

  if (!originalAgent) {
    return interaction.followUp({
      content: `Original agent "${originalAgentName}" not found in this server.`
    });
  }

  const newName = newAgentNameInput || originalAgent.name;

  // Check if an agent with the new name already exists in the target channel
  const existingAgentInTargetChannel = db
    .prepare(
      "SELECT id FROM agents WHERE guildId=? AND name=? AND channelId=?"
    )
    .get(interaction.guildId, newName, targetChannel.id);

  if (existingAgentInTargetChannel) {
    return interaction.followUp({
      content: `An agent named "${newName}" already exists in <#${targetChannel.id}>. Please choose a different name or channel.`
    });
  }

  // Verify the provider still exists
  const pr = db
    .prepare("SELECT * FROM providers WHERE guildId=? AND name=?")
    .get(interaction.guildId, originalAgent.providerName);
  if (!pr) {
    return interaction.followUp({
      content: `Provider "${originalAgent.providerName}" used by the original agent no longer exists. Please add it using \`/provider add\` or edit the original agent.`
    });
  }

  if (
    !targetChannel
      .permissionsFor(interaction.guild.members.me)
      .has(PermissionsBitField.Flags.ManageWebhooks)
  ) {
    return interaction.followUp({
      content:
        "I need the 'Manage Webhooks' permission in the target channel to clone the agent."
    });
  }

  let webhook;
  let avatarDataUriForClonedWebhook = undefined;
  if (originalAgent.avatarData && originalAgent.avatarMimeType) {
    avatarDataUriForClonedWebhook = `data:${originalAgent.avatarMimeType};base64,${originalAgent.avatarData}`;
  }

  try {
    webhook = await targetChannel.createWebhook({ name: newName, avatar: avatarDataUriForClonedWebhook });
  } catch (e) {
    console.error(`Failed to create webhook for cloned agent: ${e}`);
    let errorMessage = `Failed to create webhook for "${newName}". Discord Error: ${e.message}`;
    if (e.code === 50013) {
      errorMessage =
        `Failed to create webhook for "${newName}": I'm missing permissions in <#${targetChannel.id}>. Please ensure I have 'Manage Webhooks' permission there.`;
    }
    return interaction.followUp({ content: errorMessage });
  }

  try {
    const linkedToId = linked ? originalAgent.id : null;
    db.prepare(
      `INSERT INTO agents (
       guildId,name,model,providerName,multimodal,
       systemPrompt,avatarMimeType,avatarData,channelId,webhookId,webhookToken,
       linkedToAgentId, isSourceForLink
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      interaction.guildId,
      newName,
      originalAgent.model,
      originalAgent.providerName,
      originalAgent.multimodal,
      originalAgent.systemPrompt,
      originalAgent.avatarMimeType, 
      originalAgent.avatarData,     
      targetChannel.id,
      webhook.id,
      webhook.token,
      linkedToId,
      0 // Cloned agents are not sources by default
    );

    if (linked) {
      db.prepare("UPDATE agents SET isSourceForLink = 1 WHERE id = ?").run(originalAgent.id);
    }

    return interaction.followUp({
      content: `Agent **${originalAgentName}** successfully cloned as **${newName}** in <#${targetChannel.id}>${linked ? " and linked to the original" : ""}.`
    });
  } catch (dbError) {
    if (webhook && webhook.id) {
      try {
        await webhook.delete("Agent cloning failed due to database error.");
        console.log(
          `Webhook ${webhook.id} deleted due to DB error during agent cloning.`
        );
      } catch (whDeleteError) {
        console.warn(
          `Failed to delete webhook ${webhook.id} after DB error during clone: ${whDeleteError.message}`
        );
      }
    }
    console.error(`Database error during agent cloning: ${dbError}`);
    return interaction.followUp({
        content: `An unexpected database error occurred while cloning the agent. (${dbError.message})`
    });
  }
}

// --- /agent commands ---
async function handleAgentCmd(interaction) {
  const sub = interaction.options.getSubcommand();
  // Deferral will be handled within each subcommand function
  if (sub === "create") return agentCreate(interaction);
  if (sub === "list") return agentList(interaction); // list is quick, no defer needed inside
  if (sub === "delete") return agentDelete(interaction);
  if (sub === "edit") return agentEdit(interaction);
  if (sub === "refresh") return agentRefresh(interaction);
  if (sub === "clone") return agentClone(interaction);
}

async function agentCreate(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const name = interaction.options.getString("name");
  const model = interaction.options.getString("model");
  const providerName = interaction.options.getString("provider");
  const multimodal = interaction.options.getBoolean("multimodal");
  const sysPromptAtt = interaction.options.getAttachment("sysprompt");
  let avatarAtt = interaction.options.getAttachment("avatar"); 
  const channel =
    interaction.options.getChannel("channel") || interaction.channel;

  if (
    !channel
      .permissionsFor(interaction.guild.members.me)
      .has(PermissionsBitField.Flags.ManageWebhooks)
  ) {
    return interaction.followUp({
      content:
        "I need the 'Manage Webhooks' permission in the target channel to create an agent."
    });
  }

  const pr = db
    .prepare("SELECT * FROM providers WHERE guildId=? AND name=?")
    .get(interaction.guildId, providerName);
  if (!pr) {
    return interaction.followUp({
      content: `Provider "${providerName}" not found. Please add it using \`/provider add\`.`
    });
  }

  const fileName =
    sysPromptAtt.name || sysPromptAtt.url.split("?")[0].split("/").pop();
  const ext = path.extname(fileName).toLowerCase();
  if (ext !== ".md" && ext !== ".txt") {
    return interaction.followUp({
      content: "System prompt must be a .md or .txt file."
    });
  }

  let systemPrompt;
  try {
    const spRes = await fetch(sysPromptAtt.url);
    if (!spRes.ok) {
      return interaction.followUp({
        content: `Failed to fetch system prompt from ${sysPromptAtt.url}: ${spRes.status} ${spRes.statusText}`
      });
    }
    systemPrompt = await spRes.text();
  } catch (e) {
    console.error(`Error fetching system prompt: ${e}`);
    return interaction.followUp({
      content: `Error fetching system prompt from URL. Please ensure the link is accessible and valid. (${e.message})`
    });
  }

  let avatarDataForDB = null;
  let avatarMimeTypeForDB = null;
  let avatarDataUriForWebhook = undefined;

  if (avatarAtt) {
    try {
      const response = await fetch(avatarAtt.url);
      if (!response.ok) {
        console.warn(`Failed to fetch avatar image from ${avatarAtt.url}: ${response.status} ${response.statusText}. Agent will be created without an avatar.`);
        avatarAtt = null; 
      } else {
        const imageBuffer = await response.arrayBuffer();
        avatarDataForDB = Buffer.from(imageBuffer).toString("base64");
        avatarMimeTypeForDB = avatarAtt.contentType;
        if (!avatarMimeTypeForDB || !avatarMimeTypeForDB.startsWith("image/")) {
          console.warn(`Invalid avatar MIME type: ${avatarMimeTypeForDB}. Will attempt to create agent without avatar.`);
          avatarDataForDB = null; 
          avatarMimeTypeForDB = null;
          avatarAtt = null;
        } else {
          avatarDataUriForWebhook = `data:${avatarMimeTypeForDB};base64,${avatarDataForDB}`;
        }
      }
    } catch (e) {
      console.error(`Error fetching or processing avatar: ${e}. Agent will be created without an avatar.`);
      avatarDataForDB = null;
      avatarMimeTypeForDB = null;
      avatarAtt = null; 
    }
  }

  let webhook;
  try {
    webhook = await channel.createWebhook({ name, avatar: avatarDataUriForWebhook });
  } catch (e) {
    console.error(`Failed to create webhook: ${e}`);
    let errorMessage = `Failed to create webhook. Discord Error: ${e.message}`;
    if (e.code === 50013) {
      errorMessage =
        "Failed to create webhook: I'm missing permissions in the target channel. Please ensure I have 'Manage Webhooks' permission there.";
    }
    return interaction.followUp({ content: errorMessage });
  }

  try {
    db.prepare(
      `INSERT INTO agents (
       guildId,name,model,providerName,multimodal,
       systemPrompt,avatarMimeType,avatarData,channelId,webhookId,webhookToken,
       linkedToAgentId, isSourceForLink
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      interaction.guildId,
      name,
      model,
      providerName,
      multimodal ? 1 : 0,
      systemPrompt,
      avatarMimeTypeForDB, 
      avatarDataForDB,     
      channel.id,
      webhook.id,
      webhook.token,
      null, 
      0     
    );

    return interaction.followUp({
      content: `Agent **${name}** created in <#${channel.id}>!`
    });
  } catch (dbError) {
    if (webhook && webhook.id) {
      try {
        await webhook.delete("Agent creation failed due to database error.");
        console.log(
          `Webhook ${webhook.id} deleted due to DB error during agent creation.`
        );
      } catch (whDeleteError) {
        console.warn(
          `Failed to delete webhook ${webhook.id} after DB error: ${whDeleteError.message}`
        );
      }
    }

    if (dbError.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return interaction.followUp({
        content: `An agent named "${name}" already exists in <#${channel.id}>. Please choose a different name or channel.`
      });
    } else {
      console.error(`Database error during agent creation: ${dbError}`);
      throw dbError;
    }
  }
}

async function agentList(interaction) {
  // This is quick, no defer needed.
  const channel =
    interaction.options.getChannel("channel") || interaction.channel;
  const rows = db
    .prepare("SELECT name FROM agents WHERE guildId=? AND channelId=?")
    .all(interaction.guildId, channel.id);
  const text = rows.length
    ? `Agents in <#${channel.id}>:\n` +
      rows.map((r) => `- ${r.name}`).join("\n")
    : `No agents found in <#${channel.id}>.`;
  return interaction.reply({ content: text, ephemeral: true });
}

async function agentDelete(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const name = interaction.options.getString("name");
  const channel =
    interaction.options.getChannel("channel") || interaction.channel;
  const ag = db
    .prepare(
      "SELECT * FROM agents WHERE guildId=? AND channelId=? AND name=?"
    )
    .get(interaction.guildId, channel.id, name);

  if (!ag) {
    return interaction.followUp({
      content: `Agent "${name}" not found in <#${channel.id}>.`
    });
  }
  try {
    await client.deleteWebhook(ag.webhookId, ag.webhookToken);
  } catch (e) {
    if (e.code === 10015) {
      console.warn(
        `Webhook ${ag.webhookId} for agent ${name} was already deleted from Discord.`
      );
    } else {
      console.warn(
        `Could not delete webhook ${ag.webhookId} for agent ${name}: ${e.message}`
      );
    }
  }
  db.prepare("DELETE FROM agents WHERE id=?").run(ag.id);
  return interaction.followUp({
    content: `Agent **${name}** deleted from <#${channel.id}>.`
  });
}

async function agentEdit(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const name = interaction.options.getString("name");
  const currentChannel = interaction.channel;

  // Fetch the agent being edited
  const ag = db
    .prepare("SELECT * FROM agents WHERE guildId=? AND name=? AND channelId=?")
    .get(interaction.guildId, name, currentChannel.id);

  if (!ag) {
    return interaction.followUp({
      content: `Agent "${name}" not found in this channel (<#${currentChannel.id}>). Note: Agent name is case-sensitive.`
    });
  }

  const modelOption = interaction.options.getString("model");
  const finalModel = modelOption !== null ? modelOption : ag.model;

  const providerOption = interaction.options.getString("provider");
  let finalProviderName = ag.providerName;

  if (providerOption !== null) {
    const pr = db
      .prepare("SELECT * FROM providers WHERE guildId=? AND name=?")
      .get(interaction.guildId, providerOption);
    if (!pr) {
      return interaction.followUp({
        content: `Provider "${providerOption}" not found.`
      });
    }
    finalProviderName = providerOption;
  }

  const multimodalOption = interaction.options.getBoolean("multimodal");
  const finalMultimodal =
    multimodalOption !== null ? (multimodalOption ? 1 : 0) : ag.multimodal;

  const sysPromptAtt = interaction.options.getAttachment("sysprompt");
  let finalSystemPrompt = ag.systemPrompt;
  if (sysPromptAtt) {
    const fileName =
      sysPromptAtt.name || sysPromptAtt.url.split("?")[0].split("/").pop();
    const ext = path.extname(fileName).toLowerCase();
    if (ext !== ".md" && ext !== ".txt") {
      return interaction.followUp({
        content: "System prompt must be a .md or .txt file."
      });
    }
    try {
      const spRes = await fetch(sysPromptAtt.url);
      if (!spRes.ok) {
        return interaction.followUp({
          content: `Failed to fetch new system prompt from ${sysPromptAtt.url}: ${spRes.status} ${spRes.statusText}`
        });
      }
      finalSystemPrompt = await spRes.text();
    } catch (e) {
      console.error(`Error fetching new system prompt: ${e}`);
      return interaction.followUp({
        content: `Error fetching new system prompt. Please ensure the link is accessible. (${e.message})`
      });
    }
  }

  const avatarAtt = interaction.options.getAttachment("avatar");
  let finalAvatarMimeType = ag.avatarMimeType;
  let finalAvatarData = ag.avatarData;
  let finalAvatarDataUri = undefined;

  if (avatarAtt) { // New avatar provided
    try {
      const response = await fetch(avatarAtt.url);
      if (!response.ok) {
        console.warn(`Failed to fetch new avatar for edit from ${avatarAtt.url}: ${response.status} ${response.statusText}.`);
        // Keep existing avatar if fetch fails
        if (ag.avatarData && ag.avatarMimeType) {
          finalAvatarDataUri = `data:${ag.avatarMimeType};base64,${ag.avatarData}`;
        }
      } else {
        const imageBuffer = await response.arrayBuffer();
        finalAvatarData = Buffer.from(imageBuffer).toString("base64");
        finalAvatarMimeType = avatarAtt.contentType;
        if (!finalAvatarMimeType || !finalAvatarMimeType.startsWith("image/")) {
          console.warn(`Invalid new avatar MIME type: ${finalAvatarMimeType}. Keeping old avatar.`);
          finalAvatarData = ag.avatarData; // Revert to old data
          finalAvatarMimeType = ag.avatarMimeType; // Revert to old mime type
          if (ag.avatarData && ag.avatarMimeType) {
            finalAvatarDataUri = `data:${ag.avatarMimeType};base64,${ag.avatarData}`;
          }
        } else {
          finalAvatarDataUri = `data:${finalAvatarMimeType};base64,${finalAvatarData}`;
        }
      }
    } catch (e) {
      console.error(`Error fetching or processing new avatar for edit: ${e}. Keeping old avatar.`);
      finalAvatarData = ag.avatarData;
      finalAvatarMimeType = ag.avatarMimeType;
      if (ag.avatarData && ag.avatarMimeType) {
        finalAvatarDataUri = `data:${ag.avatarMimeType};base64,${ag.avatarData}`;
      }
    }
  } else { // No new avatar provided, use existing if available
    if (ag.avatarData && ag.avatarMimeType) {
      finalAvatarDataUri = `data:${ag.avatarMimeType};base64,${ag.avatarData}`;
    }
  }

  try {
    const wh = await client.fetchWebhook(ag.webhookId, ag.webhookToken);
    // Use ag.name because agent name cannot be changed with /agent edit for now
    // Only avatar might change here for the webhook itself.
    await wh.edit({ name: ag.name, avatar: finalAvatarDataUri });
  } catch (e) {
    console.warn(
      `Could not edit webhook for agent ${ag.name} (ID: ${ag.webhookId}). It might have been deleted or token changed. Error: ${e.message}. You may need to use /agent refresh.`
    );
  }

  try {
    // Update the primary agent
    // The avatarURL column might still exist in older DBs but is no longer updated.
    db.prepare(
      `UPDATE agents SET
       model=?, providerName=?, multimodal=?, systemPrompt=?, 
       avatarMimeType=?, avatarData=?
       WHERE id=?`
    ).run(
      finalModel,
      finalProviderName,
      finalMultimodal,
      finalSystemPrompt,
      finalAvatarMimeType, // new
      finalAvatarData,     // new
      ag.id
    );

    let updateMessage = `Agent **${ag.name}** in <#${currentChannel.id}> updated.`;

    // If this agent is a source for linked clones, propagate relevant changes
    if (ag.isSourceForLink) {
      const linkedClones = db.prepare("SELECT * FROM agents WHERE linkedToAgentId = ?").all(ag.id);
      let propagatedCount = 0;
      for (const clone of linkedClones) {
        try {
          // Propagate only specific fields. Name, channel, webhook details remain unique to the clone.
          db.prepare(
            `UPDATE agents SET
             model=?, providerName=?, multimodal=?, systemPrompt=?, 
             avatarMimeType=?, avatarData=?
             WHERE id=?`
          ).run(
            finalModel,            // from edited source
            finalProviderName,     // from edited source
            finalMultimodal,       // from edited source
            finalSystemPrompt,     // from edited source
            finalAvatarMimeType,   // new, from edited source
            finalAvatarData,       // new, from edited source
            clone.id
          );

          // Attempt to update the clone's webhook avatar (name remains clone's name)
          // Construct data URI for the clone's webhook
          let cloneAvatarDataUri = undefined;
          if (finalAvatarData && finalAvatarMimeType) {
            cloneAvatarDataUri = `data:${finalAvatarMimeType};base64,${finalAvatarData}`;
          }
          try {
            const cloneWebhook = await client.fetchWebhook(clone.webhookId, clone.webhookToken);
            await cloneWebhook.edit({ name: clone.name, avatar: cloneAvatarDataUri });
          } catch (whError) {
            console.warn(`Could not edit webhook for linked clone ${clone.name} (ID: ${clone.id}). Error: ${whError.message}`);
          }
          propagatedCount++;
        } catch (cloneDbError) {
          console.error(`Failed to update linked clone ${clone.name} (ID: ${clone.id}) in database: ${cloneDbError}`);
        }
      }
      if (propagatedCount > 0) {
        updateMessage += `\nChanges also propagated to ${propagatedCount} linked clone(s).`;
      }
    }
    return interaction.followUp({ content: updateMessage });

  } catch (dbError) {
    console.error(`Failed to update agent in database: ${dbError}`);
    return interaction.followUp({
      content: `An error occurred while updating agent data in the database. (${dbError.message})`
    });
  }
}

async function agentRefresh(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const name = interaction.options.getString("name");
  const channel = interaction.channel;

  const ag = db
    .prepare(
      "SELECT * FROM agents WHERE guildId=? AND channelId=? AND name=?"
    )
    .get(interaction.guildId, channel.id, name);

  if (!ag) {
    return interaction.followUp({
      content: `Agent "${name}" not found in this channel.`
    });
  }

  try {
    await client.deleteWebhook(ag.webhookId, ag.webhookToken);
    console.log(
      `Old webhook ${ag.webhookId} for agent ${name} deleted during refresh.`
    );
  } catch (e) {
    if (e.code === 10015) {
      console.warn(
        `Old webhook ${ag.webhookId} for agent ${name} was already deleted from Discord.`
      );
    } else {
      console.warn(
        `Could not delete old webhook ${ag.webhookId} for agent ${name} during refresh: ${e.message}. It might have been manually deleted or token changed.`
      );
    }
  }

  let newWebhook;
  let avatarDataUriForRefresh = undefined;
  if (ag.avatarData && ag.avatarMimeType) {
    avatarDataUriForRefresh = `data:${ag.avatarMimeType};base64,${ag.avatarData}`;
  }

  try {
    newWebhook = await channel.createWebhook({
      name: ag.name,
      avatar: avatarDataUriForRefresh
    });
  } catch (e) {
    console.error(`Failed to create new webhook for agent ${ag.name} during refresh: ${e}`);
    let errorMessage = `Failed to create new webhook for agent **${ag.name}**. Discord Error: ${e.message}`;
    if (e.code === 50013) {
      errorMessage = `Failed to create new webhook for **${ag.name}**: I'm missing permissions in this channel. Please ensure I have 'Manage Webhooks' permission.`;
    }
    return interaction.followUp({ content: errorMessage });
  }

  db.prepare(
    "UPDATE agents SET webhookId=?, webhookToken=? WHERE id=?"
  ).run(newWebhook.id, newWebhook.token, ag.id);

  return interaction.followUp({
    content: `Agent **${name}** webhook refreshed successfully in this channel.`
  });
}

// --- /provider commands ---
async function handleProviderCmd(interaction) {
  // These are quick, no defer needed.
  const sub = interaction.options.getSubcommand();
  if (sub === "add") {
    const name = interaction.options.getString("name");
    const url = interaction.options.getString("url");
    const key = interaction.options.getString("key");
    const { iv, encrypted, authTag } = encrypt(key);
    try {
      db.prepare(
        `INSERT INTO providers
         (guildId,name,url,encryptedKey,iv,authTag)
         VALUES (?,?,?,?,?,?)`
      ).run(interaction.guildId, name, url, encrypted, iv, authTag);
    } catch (e) {
      if (e.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return interaction.reply({
          content: `Provider "${name}" already exists in this server.`,
          ephemeral: true
        });
      }
      throw e;
    }
    return interaction.reply({
      content: `Provider **${name}** added.`,
      ephemeral: true
    });
  } else if (sub === "delete") {
    const name = interaction.options.getString("name");
    const info = db
      .prepare("DELETE FROM providers WHERE guildId=? AND name=?")
      .run(interaction.guildId, name);
    if (!info.changes) {
      return interaction.reply({
        content: `Provider "${name}" not found in this server.`,
        ephemeral: true
      });
    }
    return interaction.reply({
      content: `Provider **${name}** deleted.`,
      ephemeral: true
    });
  } else if (sub === "list") {
    const rows = db
      .prepare("SELECT name, url FROM providers WHERE guildId=? ORDER BY name")
      .all(interaction.guildId);
    if (!rows.length) {
      return interaction.reply({
        content: "No providers configured for this server. Add one with `/provider add`.",
        ephemeral: true
      });
    }
    const providerList = rows
      .map((p) => `- **${p.name}**: ${p.url}`)
      .join("\n");
    return interaction.reply({
      content: `Configured providers for this server:\n${providerList}`,
      ephemeral: true
    });
  }
}

// --- /contextwindow ---
async function handleContextWindow(interaction) {
  // Quick, no defer.
  const size = interaction.options.getInteger("size");
  db.prepare(
    `INSERT INTO guildSettings (guildId,contextWindow)
     VALUES (?,?)
     ON CONFLICT(guildId) DO UPDATE SET
       contextWindow=excluded.contextWindow`
  ).run(interaction.guildId, size);
  return interaction.reply({
    content: `Context window set to ${size} messages.`,
    ephemeral: true
  });
}

// --- /clearcontext ---
async function handleClearContext(interaction) {
  // Quick, no defer.
  const channel =
    interaction.options.getChannel("channel") || interaction.channel;
  const info = db
    .prepare(
      `
      DELETE FROM messages
      WHERE agentId IN
      (SELECT id FROM agents WHERE channelId=?)
    `
    )
    .run(channel.id);
  return interaction.reply({
    content: `Cleared ${info.changes} messages from context in <#${channel.id}>.`,
    ephemeral: true
  });
}

// utility to split text into chunks under maxLen, splitting at line breaks
function splitMessage(text, maxLen = 1900) {
  const lines = text.split("\n");
  const chunks = [];
  let buf = "";
  for (const line of lines) {
    if (buf.length + line.length + 1 > maxLen) {
      chunks.push(buf);
      buf = "";
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// --- /models command (with chunking) ---
async function handleModels(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const provided = interaction.options.getString("provider");
  let pr;

  if (provided) {
    pr = db
      .prepare(
        `SELECT * FROM providers
         WHERE guildId = ?
           AND LOWER(name) = LOWER(?)`
      )
      .get(interaction.guildId, provided);
    if (!pr) {
      return interaction.followUp({
        content: `Provider "${provided}" not found.`
      });
    }
  } else {
    pr = db
      .prepare(`SELECT * FROM providers WHERE guildId = ? ORDER BY id LIMIT 1`)
      .get(interaction.guildId);
    if (!pr) {
      return interaction.followUp({
        content:
          "No providers configured for this server. Add one with `/provider add`."
      });
    }
  }

  let apiKey;
  try {
    apiKey = decrypt(pr.encryptedKey, pr.iv, pr.authTag);
  } catch (e) {
    console.error(`Decryption error for provider ${pr.name}: ${e.message}`);
    return interaction.followUp({
      content: `Could not decrypt API key for provider "${pr.name}". Please re-add the provider.`
    });
  }

  let modelsUrl;
  try {
    const u = new URL(pr.url);
    if (/\/models\/?$/.test(u.pathname)) {
      modelsUrl = u.toString();
    } else if (/\/(?:chat\/)?completions\/?$/.test(u.pathname)) {
      u.pathname = u.pathname.replace(
        /\/(?:chat\/)?completions\/?$/,
        "/models"
      );
      modelsUrl = u.toString();
    } else {
      u.pathname = u.pathname.replace(/\/$/, "") + "/models";
      modelsUrl = u.toString();
    }
  } catch {
    return interaction.followUp({
      content: `Invalid provider URL format: ${pr.url}`
    });
  }

  let res;
  try {
    res = await fetch(modelsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });
  } catch (e) {
    console.error(`Network error fetching models from ${pr.name}: ${e}`);
    return interaction.followUp({
      content: `Network error fetching models from "${pr.name}": ${e.message}`
    });
  }

  if (res.status === 404) {
    return interaction.followUp({
      content: `Provider "${pr.name}" does not have a /models endpoint (received 404 Not Found).`
    });
  }
  if (!res.ok) {
    return interaction.followUp({
      content: `Error fetching models from "${pr.name}": ${res.status} ${res.statusText}`
    });
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    return interaction.followUp({
      content: `Received invalid JSON response from "${pr.name}" /models endpoint.`
    });
  }

  const modelList = (payload.data || [])
    .map((m) => m.id || m.name)
    .filter(Boolean);

  const listText =
    modelList.length > 0
      ? modelList.join("\n")
      : "(No models listed by provider)";
  const header = `Models from **${pr.name}**:`;
  const fullMessage = header + "\n" + listText;
  const chunks = splitMessage(fullMessage, 1900);

  await interaction.followUp({ content: chunks[0] });
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i] });
  }
}

// --- Message handling & streaming chat ---
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  // --- Auto-reply ("yap") logic ---
  // handleYapMessage will now return a Set of agent IDs it's actively handling for this message event.
  const yappingAgentIds = await handleYapMessage(message);

  // --- Standard agent mention/reply logic ---
  const agents = db
    .prepare("SELECT * FROM agents WHERE guildId=? AND channelId=?")
    .all(message.guild.id, message.channel.id);
  if (!agents.length) return; // No agents configured for this specific channel for direct replies/mentions

  let agent = null; // Agent for direct reply/mention
  if (message.reference?.messageId) {
    try {
      const orig = await message.channel.messages.fetch(
        message.reference.messageId
      );
      if (orig.webhookId) {
        agent = agents.find((a) => a.webhookId === orig.webhookId);
      }
    } catch (e) {
      // console.warn(`Could not fetch original message for reply: ${e.message}`);
    }
  }
  if (!agent) {
    const mentionMatch = message.content.match(/^@([^\s@]+)\b/i);
    if (mentionMatch) {
      const candidateName = mentionMatch[1];
      agent = agents.find(
        (a) => a.name.toLowerCase() === candidateName.toLowerCase()
      );
      if (agent) {
        message.content = message.content
          .substring(mentionMatch[0].length)
          .trim();
      }
    }
  }
  if (!agent) {
    for (const a of agents) {
      const regex = new RegExp(`\\b${a.name}\\b`, "i");
      if (regex.test(message.content)) {
        agent = a;
        break;
      }
    }
  }
  if (!agent) return;

  // If the identified agent is already being handled by yap for this message, don't trigger a standard reply.
  if (yappingAgentIds.has(agent.id)) {
    console.log(`[INFO] Agent ${agent.name} is being handled by YAP for this message. Skipping standard mention/reply.`);
    return;
  }

  if (!message.content.trim() && !message.attachments.size > 0) {
    return;
  }
  const allAgentsInChannel = agents; // These are agents in the current channel
  await agentLoop(message, agent, allAgentsInChannel, 0);
});

// --- Yap Timers and Message Buffers ---
const yapTimers = new Map(); // Key: "agentId_channelId", Value: { timerId: NodeJS.Timeout, messageBuffer: Message[] }

async function triggerYapReply(agentId, channelId, guildId) {
  const key = `${agentId}_${channelId}`;
  const yapState = yapTimers.get(key);

  if (!yapState || yapState.messageBuffer.length === 0) {
    yapTimers.delete(key);
    return;
  }

  const bufferedMessages = [...yapState.messageBuffer]; // Copy buffer
  yapState.messageBuffer = []; // Clear buffer for next batch
  yapTimers.delete(key); // Remove timer entry, new one will be set if new messages arrive

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (!agent) {
    console.error(`[YAP] Agent with ID ${agentId} not found for auto-reply.`);
    return;
  }

  const allAgentsInChannel = db
    .prepare("SELECT * FROM agents WHERE guildId = ? AND channelId = ?")
    .all(guildId, channelId);

  // Construct a single "message" from the buffered messages
  // For simplicity, concatenate content and use the first message's metadata.
  // Attachments could be more complex to merge; for now, we'll focus on text.
  const firstMessage = bufferedMessages[0];
  let combinedContent = bufferedMessages
    .map((msg) => msg.content)
    .join("\n\n");
  
  // Add a note about the auto-reply context if desired
  // combinedContent = `(Auto-replying to recent activity):\n${combinedContent}`;

  const constructedMessage = {
    guild: firstMessage.guild,
    channel: firstMessage.channel,
    channelId: channelId,
    author: firstMessage.author, // The author of the first message in the batch
    content: combinedContent.trim(),
    attachments: new Map(), // Simplification: not merging attachments for now
    reference: null,
    agentId: null, // This is an auto-reply, not from another agent directly
    guildId: guildId,
    // Add any other properties agentLoop might expect from a Message object
    // For example, if agentLoop uses message.mentions, etc.
    mentions: firstMessage.mentions, // Carry over mentions from the first message
  };

  // Collect attachments from all buffered messages
  const allAttachments = new Map();
  let attachmentCount = 0;
  for (const msg of bufferedMessages) {
    msg.attachments.forEach(att => {
      if (attachmentCount < 10) { // Discord allows max 10 attachments per message
        allAttachments.set(att.id, att);
        attachmentCount++;
      }
    });
  }
  constructedMessage.attachments = allAttachments;


  console.log(
    `[YAP] Triggering auto-reply for agent ${agent.name} in channel ${channelId} with ${bufferedMessages.length} buffered message(s).`
  );
  await agentLoop(constructedMessage, agent, allAgentsInChannel, 0);
}

async function handleYapMessage(message) {
  if (!message.guild || !message.guildId || !message.channel || !message.channel.id) return new Set();

  const yappingAgentIdsThisEvent = new Set(); // Keep track of agents handled by yap in this specific message event

  const yapConfigs = db
    .prepare(
      "SELECT agentId FROM yap_settings WHERE channelId = ? AND isEnabled = 1"
    )
    .all(message.channel.id);

  if (yapConfigs.length === 0) return yappingAgentIdsThisEvent;

  for (const config of yapConfigs) {
    const agentId = config.agentId;
    yappingAgentIdsThisEvent.add(agentId); // Mark this agent as being handled by yap for this message event
    const key = `${agentId}_${message.channel.id}`;

    let yapState = yapTimers.get(key);
    if (yapState && yapState.timerId) {
      clearTimeout(yapState.timerId);
    }

    if (!yapState) {
      yapState = { timerId: null, messageBuffer: [] };
      yapTimers.set(key, yapState);
    }

    yapState.messageBuffer.push(message);
    yapState.timerId = setTimeout(() => {
      triggerYapReply(agentId, message.channel.id, message.guild.id);
    }, 3000); // 3 seconds
  }
  return yappingAgentIdsThisEvent;
}

// --- Agent-to-agent reply loop with multi-agent context ---
async function agentLoop(message, agent, allAgentsInChannel, depth) {
  if (!message.guild || !message.guild.id) {
    console.error(
      "agentLoop called without a valid message.guild object. Skipping."
    );
    return;
  }
  const guildSettings =
    db
      .prepare(
        "SELECT contextWindow, loopDepth FROM guildSettings WHERE guildId=?"
      )
      .get(message.guild.id) || {};

  const contextWindow = guildSettings.contextWindow || 10;
  const maxLoopDepth = guildSettings.loopDepth || 2;

  if (depth > maxLoopDepth) {
    console.log(
      `Max loop depth (${maxLoopDepth}) reached for agent ${agent.name}. Stopping.`
    );
    return;
  }

  const authorName = // If message.author is null/undefined (e.g. for a yap-constructed message), handle it.
    depth === 0
      ? (message.author ? message.author.username : "ChannelActivity") 
      : allAgentsInChannel.find((a) => a.id === message.agentId)?.name || "PreviousAgent";


        let currentUserContent; // Will be string or array
        const originalTextContent = message.content; // Store original message text
        let allTextForProcessing = originalTextContent; // Initialize with original for multimodal parts and DB

        if (agent.multimodal && message.attachments.size > 0) {
          const contentParts = [];
          // Add original text content first if it exists
          if (originalTextContent.trim() !== "") {
            contentParts.push({ type: "text", text: originalTextContent });
          }

          // Use a for...of loop to handle async operations for fetching text attachments
          for (const att of message.attachments.values()) {
            if (
              att.contentType &&
              (att.contentType.startsWith("image/") ||
                /\.(png|jpe?g|gif|bmp|webp|tiff)$/i.test(att.name || att.url))
            ) {
              contentParts.push({
                type: "image_url",
                image_url: { url: att.url }
              });
            } else if ( // Check for .txt or .md files
              (att.contentType === "text/plain" || att.contentType === "text/markdown" ||
               /\.(txt|md)$/i.test(att.name || att.url))
            ) {
              try {
                const response = await fetch(att.url);
                if (response.ok) {
                  const fileText = await response.text();
                  const formattedFileText = `Content from attachment "${att.name}":\n${fileText}`;
                  // Add as a new text part for the LLM
                  contentParts.push({ type: "text", text: formattedFileText });
                  // Append to allTextForProcessing for DB record
                  allTextForProcessing += `\n\n${formattedFileText}`;
                } else {
                  console.warn(`Failed to fetch attachment ${att.name}: ${response.status}`);
                  const failureText = `[Failed to load attachment: ${att.name}]`;
                  contentParts.push({ type: "text", text: failureText });
                  allTextForProcessing += `\n\n${failureText}`;
                }
              } catch (e) {
                console.error(`Error fetching attachment ${att.name}: ${e.message}`);
                const errorText = `[Error loading attachment: ${att.name}]`;
                contentParts.push({ type: "text", text: errorText });
                allTextForProcessing += `\n\n${errorText}`;
              }
            }
          }

          // Determine currentUserContent based on processed parts.
          // If contentParts has been populated (with original text, images, or text from attachments),
          // then currentUserContent should be this array of parts, suitable for multimodal APIs.
          if (contentParts.length > 0) {
            currentUserContent = contentParts;
          } else {
            // No processable attachments found (e.g. only original text was added to contentParts and then removed, or it was empty).
            // Fallback to original text content as a simple string.
            currentUserContent = originalTextContent;
          }
        } else {
          // Not multimodal or no attachments, content is just the original text
          currentUserContent = originalTextContent;
        }

        // Use allTextForProcessing (which includes original text + text from attachments) for the database.
        // This ensures that text from .txt/.md attachments becomes part of the historical context.
        const textContentForDB = `<msg from="${authorName}">${allTextForProcessing.trim()}</msg>`;
        db.prepare(
          "INSERT INTO messages (agentId,role,content,author) VALUES (?,?,?,?)"
        ).run(agent.id, "user", textContentForDB, authorName);

  const recentMessages = db
    .prepare(
      `SELECT m.role, m.content, m.agentId, a.name as agentName
       FROM messages m
       LEFT JOIN agents a ON m.agentId = a.id
       WHERE m.agentId IN (SELECT id FROM agents WHERE channelId=?)
       ORDER BY m.timestamp DESC, m.id DESC LIMIT ?`
    )
    .all(agent.channelId, contextWindow * 2)
    .reverse();

  const providerInfo = db
    .prepare("SELECT * FROM providers WHERE guildId=? AND name=?")
    .get(message.guild.id, agent.providerName);

  if (!providerInfo) {
    console.error(
      `Provider ${agent.providerName} not found for agent ${agent.name}.`
    );
    if (message.channel && message.channel.send) {
      message.channel.send(
        `Configuration error: Provider "${agent.providerName}" for agent "${agent.name}" not found.`
      );
    }
    return;
  }
  let apiKey;
  try {
    apiKey = decrypt(
      providerInfo.encryptedKey,
      providerInfo.iv,
      providerInfo.authTag
    );
  } catch (e) {
    console.error(
      `Decryption error for provider ${providerInfo.name}: ${e.message}`
    );
    if (message.channel && message.channel.send) {
      message.channel.send(
        `Configuration error: Could not access API key for provider "${providerInfo.name}".`
      );
    }
    return;
  }

  // ... (inside agentLoop, after currentUserContent, providerInfo, allAgentsInChannel are defined)

  const isNvidiaNIM = providerInfo.url.startsWith(
    "https://integrate.api.nvidia.com/"
  );
  // currentMessageIsMultimodalWithImage: true if agent.multimodal AND currentUserContent is an array of parts
  const currentMessageIsMultimodalWithImage =
    agent.multimodal && Array.isArray(currentUserContent);

  const systemPromptText = agent.systemPrompt; // Raw system prompt from DB
  // MULTI_MSG_INSTRUCTIONS is a global constant

  let effectiveSystemPromptContent = "";
  if (systemPromptText && systemPromptText.trim() !== "") {
    effectiveSystemPromptContent = systemPromptText;
    if (MULTI_MSG_INSTRUCTIONS && MULTI_MSG_INSTRUCTIONS.trim() !== "") {
      effectiveSystemPromptContent += "\n\n" + MULTI_MSG_INSTRUCTIONS;
    }
  } else if (MULTI_MSG_INSTRUCTIONS && MULTI_MSG_INSTRUCTIONS.trim() !== "") {
    // Only multi-message instructions if system prompt is empty
    effectiveSystemPromptContent = MULTI_MSG_INSTRUCTIONS;
  }
  // If both are empty, effectiveSystemPromptContent remains ""

  const chatHistoryForLLM = [];

  // 1. Handle System Prompt based on provider and message type
  if (effectiveSystemPromptContent && effectiveSystemPromptContent.trim() !== "") {
    // Standard behavior: System prompt as role: "system"
    chatHistoryForLLM.push({
      role: "system",
      content: effectiveSystemPromptContent
    });
  }

  // Helper to strip <msg> tags from this agent's own assistant messages
  // For user messages or other agents' messages, we keep the tags.
  function stripMsgTagsForOwnAssistant(content) {
    if (typeof content !== "string") return content;
    // Regex to capture content within a single <msg>...</msg> tag,
    // assuming assistant messages are stored this way.
    const match = content.match(/^<msg(?:[^>]*)?>([\s\S]*?)<\/msg>$/);
    return match ? match[1].trim() : content.trim(); // Fallback to content.trim()
  }

  // 2. Add historical messages (from DB)
  for (const dbMsg of recentMessages) {
    let roleForLLM;
    let contentForLLM;

    if (dbMsg.role === "assistant") {
      // Message from an AI agent
      if (dbMsg.agentId === agent.id) {
        // This agent's own past message
        roleForLLM = "assistant";
        contentForLLM = stripMsgTagsForOwnAssistant(dbMsg.content); // Get raw content
      } else {
        // Another agent's past message
        roleForLLM = "user"; // Treat as user input to current agent
        contentForLLM = dbMsg.content; // Keep <msg from="OtherAgentName">...</msg>
      }
    } else {
      // Original user message from a human
      roleForLLM = "user";
      contentForLLM = dbMsg.content; // Keep <msg from="UserName">...</msg>
    }

    if (
      !contentForLLM ||
      (typeof contentForLLM === "string" && contentForLLM.trim() === "")
    ) {
      continue; // Skip if content ended up empty
    }

    const lastMessageInHistory =
      chatHistoryForLLM.length > 0
        ? chatHistoryForLLM[chatHistoryForLLM.length - 1]
        : null;

    // Merge if:
    // - lastMessageInHistory exists
    // - roles match
    // - role is not "system"
    // - both lastMessageInHistory.content and contentForLLM are strings
    if (
      lastMessageInHistory &&
      lastMessageInHistory.role === roleForLLM &&
      roleForLLM !== "system" &&
      typeof lastMessageInHistory.content === "string" &&
      typeof contentForLLM === "string"
    ) {
      lastMessageInHistory.content = (
        lastMessageInHistory.content +
        "\n" +
        contentForLLM
      ).trim();
    } else {
      chatHistoryForLLM.push({ role: roleForLLM, content: contentForLLM });
    }
  }

  // 3. Add the *current* message (which can be multimodal array or string)
  //    currentUserContent was prepared earlier.
  //    The role is always 'user' for the message that initiated this loop.
  //    This is a new, distinct input, so no merging with the last historical message.
  if (
    currentUserContent &&
    (Array.isArray(currentUserContent) ||
      (typeof currentUserContent === "string" &&
        currentUserContent.trim() !== ""))
  ) {
    chatHistoryForLLM.push({ role: "user", content: currentUserContent });
  }

  // --- The fetch call to the LLM now uses the fully constructed chatHistoryForLLM ---
  // try {
  //   llmResponse = await fetch(completionsUrl, { /* ... */ body: JSON.stringify({ model: agent.model, messages: chatHistoryForLLM, stream: true }) });
  // } catch (fetchError) { /* ... */ }

  let completionsUrl;
  try {
    const u = new URL(providerInfo.url);
    if (u.hostname.includes("groq.com")) {
      u.pathname = "/openai/v1/chat/completions";
      completionsUrl = u.toString();
    } else if (/\/chat\/completions\/?$/.test(u.pathname)) {
      completionsUrl = u.toString();
    } else if (
      /\/completions\/?$/.test(u.pathname) &&
      !u.pathname.includes("/chat/")
    ) {
      completionsUrl = u.toString();
    } else {
      u.pathname = u.pathname.replace(/\/$/, "") + "/chat/completions";
      completionsUrl = u.toString();
    }
  } catch {
    const targetChannel =
      message.channel ||
      (agent.channelId && client.channels.cache.get(agent.channelId));
    if (targetChannel && targetChannel.send) {
      targetChannel.send(
        `Invalid provider URL configured for "${providerInfo.name}": ${providerInfo.url}`
      );
    }
    return;
  }

  const targetChannel =
    message.channel ||
    (agent.channelId && client.channels.cache.get(agent.channelId));
  if (targetChannel && typeof targetChannel.sendTyping === "function") {
    targetChannel.sendTyping().catch(console.warn);
  }

  let llmResponse;
  try {
    const requestBody = JSON.stringify({
      model: agent.model,
      messages: chatHistoryForLLM,
      stream: true
    });
    if (process.env.verbose === 'true') {
      console.log(`[VERBOSE] LLM Request to ${completionsUrl}:`, requestBody);
    }
    llmResponse = await fetch(completionsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: requestBody
    });
    if (process.env.verbose === 'true') {
      console.log(`[VERBOSE] LLM Response Status from ${completionsUrl}: ${llmResponse.status} ${llmResponse.statusText}`);
      // Note: Cannot easily log the full raw response body here as it's a stream.
      // Logging individual chunks in the lineReader below.
    }
  } catch (fetchError) {
    console.error(
      `Fetch error calling LLM for agent ${agent.name}: ${fetchError}`
    );
    if (targetChannel && targetChannel.send) {
      targetChannel.send(
        `Error contacting LLM provider "${providerInfo.name}": ${fetchError.message}`
      );
    }
    return;
  }

  if (!llmResponse.ok) {
    const errorBody = await llmResponse
      .text()
      .catch(() => "Could not read error body.");
    console.error(
      `LLM provider error for agent ${agent.name} (${llmResponse.status} ${llmResponse.statusText}): ${errorBody}`
    );
    if (targetChannel && targetChannel.send) {
      targetChannel.send(
        `LLM Provider "${providerInfo.name}" returned an error: ${
          llmResponse.status
        } ${
          llmResponse.statusText
        }. Details: ${errorBody.substring(0, 500)}`
      );
    }
    return;
  }

  if (!llmResponse.body) {
    console.error(`LLM response body is null for agent ${agent.name}.`);
    if (targetChannel && targetChannel.send) {
      targetChannel.send(
        `Received an empty response from LLM provider "${providerInfo.name}".`
      );
    }
    return;
  }

  const webhookClient = new WebhookClient({
    id: agent.webhookId,
    token: agent.webhookToken
  });

  let streamBuffer = "";
  let fullRepliesContent = [];

  const readableStream = Readable.fromWeb(llmResponse.body);
  const lineReader = readline.createInterface({ input: readableStream });

  lineReader.on("line", async (line) => {
    if (line.startsWith("data: ")) {
      const dataChunk = line.substring(6);
      if (dataChunk === "[DONE]") {
        streamBuffer = "";
        lineReader.close();
        return;
      }
      if (process.env.verbose === 'true') {
          console.log(`[VERBOSE] LLM Stream Chunk: ${dataChunk}`);
      }
      try {
        const parsedChunk = JSON.parse(dataChunk);
        const delta = parsedChunk.choices?.[0]?.delta?.content || "";
        streamBuffer += delta;

        // Strip <think>...</think> tags and their content
        // This regex will find <think> tags and everything between them, non-greedily.
        const thinkTagRegex = /<think>[\s\S]*?<\/think>/g;
        streamBuffer = streamBuffer.replace(thinkTagRegex, "").trim();

        const tagRegex = /<msg(?:[^>]*)>([\s\S]*?)<\/msg>/g;
        let match;
        let lastIndex = 0;
        while ((match = tagRegex.exec(streamBuffer)) !== null) {
          const fullTag = match[0];
          const innerContent = match[1];

          if (innerContent.trim()) {
            if (process.env.verbose === 'true') {
                console.log(`[VERBOSE] Sending Webhook Message for agent ${agent.name}: ${innerContent}`);
            }
            webhookClient.send({ content: innerContent }).catch((e) => {
              console.error(
                `Webhook send error for agent ${agent.name}: ${e.message}`
              );
            });
            db.prepare(
              "INSERT INTO messages (agentId,role,content) VALUES (?,?,?)"
            ).run(agent.id, "assistant", fullTag);
            fullRepliesContent.push(innerContent);
          }
          lastIndex = tagRegex.lastIndex;
        }
        streamBuffer = streamBuffer.substring(lastIndex);
      } catch (e) {
        // console.warn("Stream parsing error or incomplete JSON:", dataChunk, e.message);
      }
    }
  });

  lineReader.on("close", async () => {
    // Handle any leftover buffer content that wasn't wrapped in <msg> tags
    if (streamBuffer.trim()) {
      const thinkTagRegex = /<think>[\s\S]*?<\/think>/g;
      let cleanedLeftover = streamBuffer.replace(thinkTagRegex, "").trim();

      if (cleanedLeftover) {
        const warningMessage = "\n\n---\n*Warning: LLM did not correctly format this part of the message. It should have been wrapped in `<msg>` tags.*";
        const messageToSendWithWarning = cleanedLeftover + warningMessage;
        
        if (process.env.verbose === 'true') {
            console.log(`[VERBOSE] Sending Webhook Message (leftover) for agent ${agent.name}: ${messageToSendWithWarning}`);
        }
        webhookClient.send({ content: messageToSendWithWarning }).catch((e) => {
          console.error(
            `Webhook send error (leftover) for agent ${agent.name}: ${e.message}`
          );
        });
        // Store the original leftover content (without warning) in DB and for inter-agent comms
        db.prepare(
          "INSERT INTO messages (agentId,role,content) VALUES (?,?,?)"
        ).run(agent.id, "assistant", `<msg>${cleanedLeftover}</msg>`);
        fullRepliesContent.push(cleanedLeftover); // Add to content for further processing
      }
    }
    streamBuffer = ""; // Ensure buffer is cleared after processing potential leftovers

    const combinedReplyText = fullRepliesContent.join(" ");
    for (const otherAgent of allAgentsInChannel) {
      if (
        otherAgent.id !== agent.id &&
        new RegExp(`\\b${otherAgent.name}\\b`, "i").test(combinedReplyText)
      ) {
        console.log(
          `Agent ${agent.name} mentioned agent ${otherAgent.name}. Triggering loop (depth ${depth + 1}).`
        );
        const nextMessage = {
          guild: message.guild,
          channel: message.channel,
          channelId: message.channel.id,
          author: { username: agent.name, bot: true },
          content: combinedReplyText,
          attachments: new Map(),
          reference: null,
          agentId: agent.id
        };
        if (message.guild && message.guild.id) {
          nextMessage.guildId = message.guild.id;
        }
        await agentLoop(
          nextMessage,
          otherAgent,
          allAgentsInChannel,
          depth + 1
        );
      }
    }
  });

  lineReader.on("error", (err) => {
    console.error(
      `Readline stream error for agent ${agent.name}: ${err.message}`
    );
    if (targetChannel && targetChannel.send) {
      targetChannel.send(
        `An error occurred while processing the LLM response for agent "${agent.name}".`
      );
    }
  });
}

client.login(TOKEN);

module.exports = {
  encrypt,
  decrypt,
  splitMessage,
  handleProviderCmd,
  handleHelp,
  handleContextWindow,
  handleLoopDepth,
  agentLoop, // Exporting for testing
  MULTI_MSG_INSTRUCTIONS, // Exporting for testing
  db, // Exporting for testing
};
