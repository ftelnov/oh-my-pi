import { describe, expect, it } from "bun:test";
import { jtdToJsonSchema } from "@oh-my-pi/pi-coding-agent/tools/jtd-to-json-schema";

describe("jtd property named 'ref' collision", () => {
	it("handles 'ref' as a property name inside JTD elements", () => {
		// Matches the explore agent's schema:
		// files:
		//   elements:
		//     properties:
		//       ref: { type: string }
		//       description: { type: string }
		const converted = jtdToJsonSchema({
			properties: {
				summary: { type: "string" },
				files: {
					elements: {
						properties: {
							ref: { type: "string" },
							description: { type: "string" },
						},
					},
				},
			},
		});

		const items = (converted as any).properties.files.items;
		expect(items).not.toHaveProperty("$ref");
		expect(items).toHaveProperty("properties.ref");
		expect(items.properties.ref).toEqual({ type: "string" });
		expect(items.properties.description).toEqual({ type: "string" });
	});

	it("handles 'ref' property in mixed JTD/JSON Schema nodes", () => {
		const converted = jtdToJsonSchema({
			type: "object",
			properties: {
				items: {
					type: "array",
					elements: {
						properties: {
							ref: { type: "string" },
						},
					},
				},
			},
			required: ["items"],
		});

		const items = (converted as any).properties.items.items;
		expect(items).not.toHaveProperty("$ref");
		expect(items).toHaveProperty("properties.ref");
	});
});
