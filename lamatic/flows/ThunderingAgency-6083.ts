const flowConfig = {
  "id": "f1ab24d1-c5bb-4e3f-a453-2ebaa657ff4c",
  "name": "4 - RAG Chatbot",
  "nodes": [
    {
      "id": "sticky-note-601",
      "data": {
        "width": 541,
        "height": 431,
        "nodeId": "stickyNoteNode",
        "values": {
          "text": "# 🔁 Built in RAG\n\n---\n\nThe RAG (Retrieval-Augmented Generation) Node is a sophisticated AI component that combines information retrieval with text generation. It first retrieves relevant information from a knowledge base or vector database, then uses that context to generate more accurate and informed responses. This approach returns Contextual LLM response faster than normal setup. \n\nYou can customize LLM context with - \n\n1. Multi-vectorDB - Choose context from many vectorDB running search in parallel\n2. Query - A modified Accurate vector search query for better responses\n3. Custom Filter - Pass metadata filer for search on precise data\n4. Certainty - Select the level of similarity to consider a match\n5. Number of Reference - Choose how many results to be returned.\n\n---\n\n📖 Read the Docs - [RAG Node](https://lamatic.ai/docs/nodes/ai/rag-node)",
          "color": "purple",
          "nodeId": "stickyNoteNode",
          "nodeName": "Sticky Note",
          "nodeType": "stickyNoteNode"
        }
      },
      "type": "stickyNoteNode",
      "zIndex": -10,
      "dragging": false,
      "measured": {
        "width": 541,
        "height": 431
      },
      "position": {
        "x": -638.7897793525567,
        "y": -31.683339328701322
      },
      "selected": false,
      "draggable": true
    },
    {
      "id": "sticky-note-384",
      "data": {
        "width": 612,
        "height": 467,
        "nodeId": "stickyNoteNode",
        "values": {
          "text": "# **▶️ Try it out**\n\n---\n\n1. Chat Widget trigger allows you to run a flow whenever a users sends a message.  \n**🎨Customize Chat Widget appearance and behaviour inside the chat widget node**\n2. 🛠️ Configure RAG Node for contextual Response Generation  \n   1. **Setup embedding and AI Model**  \n   2. **Configure System Prompt**  \n   3. **Choose VectorDB**  \n   4. **Pass Query**  \n   5. **Fine Tune results with certainty, references count and filters**  \n   6. ▶️**Test AI Node**\n3. ➕ Map the output to the chat response\n4. Run flow by clicking\n\n# ▶️ **Test 👇🏻**\n\n1. Find Setup instructions to embed this widget on your website\n\n# **〈〉 Setup 👆🏻**",
          "color": "yellow",
          "nodeId": "stickyNoteNode",
          "nodeName": "Sticky Note",
          "nodeType": "stickyNoteNode"
        }
      },
      "type": "stickyNoteNode",
      "zIndex": -10,
      "dragging": false,
      "measured": {
        "width": 612,
        "height": 467
      },
      "position": {
        "x": 258.9095213688488,
        "y": -52.43504027155166
      },
      "selected": false,
      "draggable": true
    },
    {
      "id": "triggerNode_1",
      "data": {
        "modes": {},
        "nodeId": "chatTriggerNode",
        "values": {
          "chat": "",
          "domains": [
            "*"
          ],
          "nodeName": "Chat Widget",
          "chatConfig": {
            "botName": "Lamatic Bot",
            "imageUrl": "https://img.freepik.com/premium-vector/robot-android-super-hero_111928-7.jpg?w=826",
            "position": "right",
            "policyUrl": "https://lamatic.ai/docs/legal/privacy-policy",
            "displayMode": "popup",
            "placeholder": "Compose your message",
            "suggestions": [
              "What is lamatic?",
              "How do I add data to my chatbot?",
              "Explain this product to me"
            ],
            "errorMessage": "Oops! Something went wrong. Please try again.",
            "hideBranding": false,
            "primaryColor": "#ef4444",
            "headerBgColor": "#000000",
            "greetingMessage": "Hi, I am Lamatic Bot. Ask me anything about Lamatic",
            "headerTextColor": "#FFFFFF",
            "showEmojiButton": true,
            "suggestionBgColor": "#f1f5f9",
            "userMessageBgColor": "#FEF2F2",
            "agentMessageBgColor": "#f1f5f9",
            "suggestionTextColor": "#334155",
            "userMessageTextColor": "#d12323",
            "agentMessageTextColor": "#334155"
          }
        },
        "trigger": true
      },
      "type": "triggerNode",
      "measured": {
        "width": 216,
        "height": 93
      },
      "position": {
        "x": 0,
        "y": 0
      },
      "selected": false
    },
    {
      "id": "RAGNode_157",
      "data": {
        "label": "dynamicNode node",
        "logic": [],
        "modes": {},
        "nodeId": "RAGNode",
        "values": {
          "id": "RAGNode_157",
          "limit": 5,
          "prompts": [
            {
              "id": "2a6bb169-5773-473c-8797-409591213626",
              "role": "system",
              "content": ""
            }
          ],
          "nodeName": "RAG",
          "vectorDB": [
            "quickstart"
          ],
          "certainty": "0.64",
          "queryField": "{{triggerNode_1.output.chatMessage}}",
          "embeddingModelName": {
            "type": "embedder/text",
            "params": {},
            "model_name": "text-embedding-ada-002",
            "credentialId": "2823d3c3-74b8-45a2-85da-2e45151955f8",
            "provider_name": "openai",
            "credential_name": "openai-1"
          },
          "generativeModelName": [
            {
              "type": "generator/text",
              "params": {},
              "configName": "default",
              "model_name": "gpt-4o-mini",
              "credentialId": "2823d3c3-74b8-45a2-85da-2e45151955f8",
              "provider_name": "openai",
              "credential_name": "openai-1"
            }
          ]
        }
      },
      "type": "dynamicNode",
      "measured": {
        "width": 216,
        "height": 93
      },
      "position": {
        "x": 0,
        "y": 130
      },
      "selected": false
    },
    {
      "id": "responseNode_triggerNode_1",
      "data": {
        "label": "Response",
        "nodeId": "chatResponseNode",
        "values": {
          "content": "{{RAGNode_157.output.modelResponse}}",
          "nodeName": "Chat Response",
          "references": "",
          "webhookUrl": "",
          "webhookHeaders": ""
        },
        "isResponseNode": true
      },
      "type": "responseNode",
      "measured": {
        "width": 216,
        "height": 93
      },
      "position": {
        "x": 0,
        "y": 260
      },
      "selected": false
    }
  ],
  "edges": [
    {
      "id": "triggerNode_1-RAGNode_157",
      "type": "defaultEdge",
      "source": "triggerNode_1",
      "target": "RAGNode_157",
      "sourceHandle": "bottom",
      "targetHandle": "top"
    },
    {
      "id": "RAGNode_157-responseNode_triggerNode_1",
      "type": "defaultEdge",
      "source": "RAGNode_157",
      "target": "responseNode_triggerNode_1",
      "selected": false,
      "sourceHandle": "bottom",
      "targetHandle": "top"
    },
    {
      "id": "response-trigger_triggerNode_1",
      "type": "responseEdge",
      "source": "triggerNode_1",
      "target": "responseNode_triggerNode_1",
      "sourceHandle": "to-response",
      "targetHandle": "from-trigger"
    }
  ],
  "status": "active",
  "created_at": "2026-07-29T19:12:09.004194+00:00"
};

export async function getNodesAndEdges(): Promise<{
    nodes: Record<string, any>[],
    edges: Record<string, any>[],
}> {
    return {
        nodes: flowConfig.nodes,
        edges: flowConfig.edges,
    }
}

export async function getFlowConfig(): Promise<Record<string, any>> {
    return flowConfig;
}