const promptConfig = {
  "id": "1b31abd1-6f42-4022-8ac9-b1f251389a52",
  "name": "test",
  "config": {
    "values": {
      "tools": [],
      "prompts": [
        {
          "id": "187c2f4b-c23d-4545-abef-73dc897d6b7b",
          "role": "system",
          "content": "You are an AI Assistant"
        },
        {
          "id": "187c2f4b-c23d-4545-abef-73dc897d6b7d",
          "role": "user",
          "content": "Write your prompt here"
        }
      ],
      "memories": "[]",
      "messages": "[]",
      "nodeName": "test",
      "attachments": "",
      "credentials": "",
      "generativeModelName": [
        {
          "type": "generator/text",
          "params": {},
          "configName": "configA",
          "provider_name": "",
          "credential_name": ""
        }
      ]
    }
  },
  "type": "LLMNode",
  "status": "inactive",
  "created_at": "2026-07-29T19:15:04.95714+00:00"
};

export async function getPromptConfig(): Promise<Record<string, any>> {
    return promptConfig;
}