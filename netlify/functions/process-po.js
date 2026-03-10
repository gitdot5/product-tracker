export const handler = async (event, context) => {
    // Only allow POST requests
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const { base64Image } = JSON.parse(event.body);

        if (!base64Image) {
            return { statusCode: 400, body: JSON.stringify({ error: "No image provided" }) };
        }

        const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

        if (!OPENAI_API_KEY) {
            return { statusCode: 500, body: JSON.stringify({ error: "Server missing OpenAI API Key configuration." }) };
        }

        // Prepare the payload for the OpenAI Vision API
        const payload = {
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `You are an expert OCR AI that extracts structured data from medical supply Purchase Orders and Invoices. 
Your ONLY output must be a raw JSON object (do not wrap in markdown tags like \`\`\`json). 
Extract the following fields based on the image provided:
- facility: The hospital or facility name (e.g., "Northside"). Keep it concise.
- vendor: The vendor name (e.g., "Xtant", "MiMedx").
- date: The date on the document in YYYY-MM-DD format.
- productName: The specific product/graft name (e.g., "OsteoVive Plus Syringe 5cc").
- itemNumber: The specific item number, product code, or catalog number (e.g., "203205" or "OB25-0177-080").
- cost: The total cost or unit price as a raw number without currency symbols (e.g., 1375).
- patient: The patient name if completely available, otherwise "Unknown".`
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Extract the data from this medical purchase order into JSON." },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                    ]
                }
            ],
            max_tokens: 300
        };

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("OpenAI Error:", errorText);
            return { statusCode: response.status, body: JSON.stringify({ error: "Failed to process image with AI" }) };
        }

        const data = await response.json();

        let jsonResult = data.choices[0].message.content;

        // Robustly extract JSON block if the AI ignored strict instructions
        const match = jsonResult.match(/\{[\s\S]*\}/);
        if (match) {
            jsonResult = match[0];
        } else {
            jsonResult = jsonResult.replace(/```json/gi, "").replace(/```/g, "").trim();
        }

        // Validate JSON
        const parsedResult = JSON.parse(jsonResult);

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(parsedResult)
        };

    } catch (error) {
        console.error("Exception in process-po:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: `Internal Server Error: ${error.message}` })
        };
    }
};
