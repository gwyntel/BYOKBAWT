# BYOKBAWT
Bring Your Own Key BAWT - A discord ai agent that allows multiple openai compatible providers. 

# Install
1. clone the repository
2. run NPM install in the repo folder that contains package.json
3. setup your .env file. 

```
DISCORD_TOKEN=get from https://discord.com/developers/applications/
CLIENT_ID=get from https://discord.com/developers/applications/
ENCRYPTION_KEY=64char hex string
verbose=false or true
```

# Configuration
after connecting to discord, add to a server and then follow these steps:

add a provider:
/provider add OpenAI https://api.openai.com/v1/chat/completions sk_proj_blah_blah_blah

list models (skip if you know the model id you want to use)
/models list OpenAI

create an agent
/agent create GPT4.1 gpt-4.1 OpenAI True SysPrompt.md Avatar.png

chat with the agent by mentioning the agent name, replying to a sent message, or enabling /yap. 
