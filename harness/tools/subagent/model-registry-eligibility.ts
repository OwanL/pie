/** Provider-qualified model registry view used only by subagent sessions. */

export interface SourceModelRegistry<Model extends { provider: string; id: string }, AuthResult = unknown> {
	getAvailable?: () => Model[];
	getAll?: () => Model[];
	find?: (provider: string, id: string) => Model | undefined;
	getApiKeyAndHeaders?(model: Model): AuthResult | Promise<AuthResult>;
	isModelEligibleForSubagent?: (provider: string, id: string) => boolean;
}

/**
 * Restrict child-session discovery and request authentication to models allowed
 * by the registry's provider-qualified policy. Registries without a policy are
 * returned unchanged for compatibility with older SDK/test registries.
 *
 * Methods are invoked with the native registry as `this`: some SDK registry
 * implementations use private fields and cannot safely be called with a Proxy
 * receiver.
 */
export function createSubagentModelRegistryView<
	Model extends { provider: string; id: string },
	AuthResult,
	Registry extends SourceModelRegistry<Model, AuthResult>,
>(registry: Registry): Registry {
	const isEligible = registry.isModelEligibleForSubagent;
	if (!isEligible) return registry;

	const eligible = (provider: string, id: string): boolean =>
		Reflect.apply(isEligible, registry, [provider, id]) === true;
	const filtered = (method: "getAvailable" | "getAll") => {
		const native = registry[method];
		if (typeof native !== "function") return undefined;
		return () => (Reflect.apply(native, registry, []) as Model[])
			.filter((model) => eligible(model.provider, model.id));
	};

	return new Proxy(registry, {
		get(target, property) {
			if (property === "getAvailable" || property === "getAll") {
				return filtered(property);
			}
			if (property === "find") {
				const native = target.find;
				if (typeof native !== "function") return undefined;
				return (provider: string, id: string) => {
					if (!eligible(provider, id)) return undefined;
					const model = Reflect.apply(native, target, [provider, id]) as Model | undefined;
					return model && eligible(model.provider, model.id) ? model : undefined;
				};
			}
			if (property === "getApiKeyAndHeaders") {
				const native = target.getApiKeyAndHeaders;
				if (typeof native !== "function") return undefined;
				return (model: Model) => {
					if (!eligible(model.provider, model.id)) {
						return Promise.reject(new Error(`Model ${model.provider}/${model.id} is not eligible for subagents`));
					}
					return Reflect.apply(native, target, [model]);
				};
			}
			const value = Reflect.get(target, property, target) as unknown;
			// Preserve the receiver for every native method, not just the methods
			// overridden above. Bind only functions; non-function members retain
			// their native identity (notably auth-storage-related references).
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Registry;
}
