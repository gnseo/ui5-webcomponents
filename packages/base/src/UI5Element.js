import merge from "@ui5/webcomponents-utils/dist/sap/base/util/merge.js";
import boot from "./boot.js";
import { skipOriginalEvent } from "./config/NoConflict.js";
import DOMObserver from "./compatibility/DOMObserver.js";
import UI5ElementMetadata from "./UI5ElementMetadata.js";
import StaticAreaItem from "./StaticAreaItem.js";
import Integer from "./types/Integer.js";
import RenderScheduler from "./RenderScheduler.js";
import { getConstructableStyle, createHeadStyle } from "./CSS.js";
import { getEffectiveStyle } from "./Theming.js";
import { kebabToCamelCase, camelToKebabCase } from "./util/StringHelper.js";
import isValidPropertyName from "./util/isValidPropertyName.js";

const metadata = {
	events: {
		_propertyChange: {},
	},
};

const DefinitionsSet = new Set();
const IDMap = new Map();

const elementTimeouts = new Map();

const GLOBAL_CONTENT_DENSITY_CSS_VAR = "--_ui5_content_density";
/**
 * Base class for all UI5 Web Components
 *
 * @class
 * @constructor
 * @author SAP SE
 * @alias sap.ui.webcomponents.base.UI5Element
 * @extends HTMLElement
 * @public
 */
class UI5Element extends HTMLElement {
	constructor() {
		super();
		this._generateId();
		this._initializeState();
		this._upgradeAllProperties();
		this._initializeContainers();

		let deferredResolve;
		this._domRefReadyPromise = new Promise(resolve => {
			deferredResolve = resolve;
		});
		this._domRefReadyPromise._deferredResolve = deferredResolve;

		this._monitoredChildProps = new Map();
	}

	/**
	 * @private
	 */
	_generateId() {
		this._id = this.constructor._nextID();
	}

	/**
	 * @private
	 */
	_initializeContainers() {
		// Init Shadow Root
		if (this.constructor._needsShadowDOM()) {
			this.attachShadow({ mode: "open" });

			// IE11, Edge
			if (window.ShadyDOM) {
				createHeadStyle(this.constructor);
			}

			// Chrome
			if (document.adoptedStyleSheets) {
				const style = getConstructableStyle(this.constructor);
				this.shadowRoot.adoptedStyleSheets = [style];
			}
		}

		// Init StaticAreaItem only if needed
		if (this.constructor._needsStaticArea()) {
			this.staticAreaItem = new StaticAreaItem(this);
		}
	}

	/**
	 * Do not call this method from derivatives of UI5Element, use "onEnterDOM" only
	 * @private
	 */
	async connectedCallback() {
		// Render the Shadow DOM
		if (this.constructor._needsShadowDOM()) {
			// always register the observer before yielding control to the main thread (await)
			this._startObservingDOMChildren();

			await this._processChildren();
			await RenderScheduler.renderImmediately(this);
			this._domRefReadyPromise._deferredResolve();
			if (typeof this.onEnterDOM === "function") {
				this.onEnterDOM();
			}
		}

		// Render Fragment if neccessary
		if (this.constructor._needsStaticArea()) {
			this.staticAreaItem._updateFragment(this);
		}
	}

	/**
	 * Do not call this method from derivatives of UI5Element, use "onExitDOM" only
	 * @private
	 */
	disconnectedCallback() {
		if (this.constructor._needsShadowDOM()) {
			this._stopObservingDOMChildren();
			if (typeof this.onExitDOM === "function") {
				this.onExitDOM();
			}
		}

		if (this.constructor._needsStaticArea()) {
			this.staticAreaItem._removeFragmentFromStaticArea();
		}
	}

	/**
	 * @private
	 */
	_startObservingDOMChildren() {
		const shouldObserveChildren = this.constructor.getMetadata().hasSlots();
		if (!shouldObserveChildren) {
			return;
		}
		const mutationObserverOptions = {
			childList: true,
			subtree: true,
			characterData: true,
		};
		DOMObserver.observeDOMNode(this, this._processChildren.bind(this), mutationObserverOptions);
	}

	/**
	 * @private
	 */
	_stopObservingDOMChildren() {
		DOMObserver.unobserveDOMNode(this);
	}

	/**
	 * Note: this method is also manually called by "compatibility/patchNodeValue.js"
	 * @private
	 */
	async _processChildren() {
		const hasSlots = this.constructor.getMetadata().hasSlots();
		if (hasSlots) {
			await this._updateSlots();
		}
	}

	/**
	 * @private
	 */
	async _updateSlots() {
		const slotsMap = this.constructor.getMetadata().getSlots();
		const canSlotText = slotsMap.default && slotsMap.default.type === Node;
		const domChildren = Array.from(canSlotText ? this.childNodes : this.children);

		// Init the _state object based on the supported slots
		for (const [slotName, slotData] of Object.entries(slotsMap)) { // eslint-disable-line
			this._clearSlot(slotName);
		}

		const autoIncrementMap = new Map();
		const slottedChildrenMap = new Map();

		const allChildrenUpgraded = domChildren.map(async (child, idx) => {
			// Determine the type of the child (mainly by the slot attribute)
			const slotName = this.constructor._getSlotName(child);
			const slotData = slotsMap[slotName];

			// Check if the slotName is supported
			if (slotData === undefined) {
				const validValues = Object.keys(slotsMap).join(", ");
				console.warn(`Unknown slotName: ${slotName}, ignoring`, child, `Valid values are: ${validValues}`); // eslint-disable-line
				return;
			}

			// For children that need individual slots, calculate them
			if (slotData.individualSlots) {
				const nextId = (autoIncrementMap.get(slotName) || 0) + 1;
				autoIncrementMap.set(slotName, nextId);
				child._individualSlot = `${slotName}-${nextId}`;
			}

			// Await for not-yet-defined custom elements
			if (child instanceof HTMLElement) {
				const localName = child.localName;
				const isCustomElement = localName.includes("-");
				if (isCustomElement) {
					const isDefined = window.customElements.get(localName);
					if (!isDefined) {
						const whenDefinedPromise = window.customElements.whenDefined(localName); // Class registered, but instances not upgraded yet
						let timeoutPromise = elementTimeouts.get(localName);
						if (!timeoutPromise) {
							timeoutPromise = new Promise(resolve => setTimeout(resolve, 1000));
							elementTimeouts.set(localName, timeoutPromise);
						}
						await Promise.race([whenDefinedPromise, timeoutPromise]);
					}
					window.customElements.upgrade(child);
				}
			}

			child = this.constructor.getMetadata().constructor.validateSlotValue(child, slotData);

			if (child.isUI5Element) {
				this._attachChildPropertyUpdated(child, slotData);
			}

			const propertyName = slotData.propertyName || slotName;

			if (slottedChildrenMap.has(propertyName)) {
				slottedChildrenMap.get(propertyName).push({ child, idx });
			} else {
				slottedChildrenMap.set(propertyName, [{ child, idx }]);
			}
		});

		await Promise.all(allChildrenUpgraded);

		// Distribute the child in the _state object, keeping the Light DOM order,
		// not the order elements are defined.
		slottedChildrenMap.forEach((children, slot) => {
			this._state[slot] = children.sort((a, b) => a.idx - b.idx).map(_ => _.child);
		});
		this._invalidate();
	}

	/**
	 * Removes all children from the slot and detaches listeners, if any
	 * @private
	 */
	_clearSlot(slotName) {
		const slotData = this.constructor.getMetadata().getSlots()[slotName];
		const propertyName = slotData.propertyName || slotName;

		let children = this._state[propertyName];
		if (!Array.isArray(children)) {
			children = [children];
		}

		children.forEach(child => {
			if (child && child.isUI5Element) {
				this._detachChildPropertyUpdated(child);
			}
		});

		this._state[propertyName] = [];
		this._invalidate(propertyName, []);
	}

	/**
	 * Do not override this method in derivatives of UI5Element
	 * @private
	 */
	attributeChangedCallback(name, oldValue, newValue) {
		const properties = this.constructor.getMetadata().getProperties();
		const realName = name.replace(/^ui5-/, "");
		const nameInCamelCase = kebabToCamelCase(realName);
		if (properties.hasOwnProperty(nameInCamelCase)) { // eslint-disable-line
			const propertyTypeClass = properties[nameInCamelCase].type;
			if (propertyTypeClass === Boolean) {
				newValue = newValue !== null;
			}
			if (propertyTypeClass === Integer) {
				newValue = parseInt(newValue);
			}
			this[nameInCamelCase] = newValue;
		}
	}

	/**
	 * @private
	 */
	_updateAttribute(name, newValue) {
		if (!this.constructor.getMetadata().hasAttribute(name)) {
			return;
		}

		if (typeof newValue === "object") {
			return;
		}

		const attrName = camelToKebabCase(name);
		const attrValue = this.getAttribute(attrName);
		if (typeof newValue === "boolean") {
			if (newValue === true && attrValue === null) {
				this.setAttribute(attrName, "");
			} else if (newValue === false && attrValue !== null) {
				this.removeAttribute(attrName);
			}
		} else if (attrValue !== newValue) {
			this.setAttribute(attrName, newValue);
		}
	}

	/**
	 * @private
	 */
	_upgradeProperty(prop) {
		if (this.hasOwnProperty(prop)) { // eslint-disable-line
			const value = this[prop];
			delete this[prop];
			this[prop] = value;
		}
	}

	/**
	 * @private
	 */
	_upgradeAllProperties() {
		const allProps = this.constructor.getMetadata().getPropertiesList();
		allProps.forEach(this._upgradeProperty, this);
	}

	/**
	 * @private
	 */
	_initializeState() {
		const defaultState = this.constructor._getDefaultState();
		this._state = Object.assign({}, defaultState);
	}

	/**
	 * @private
	 */
	_attachChildPropertyUpdated(child, propData) {
		const listenFor = propData.listenFor,
			childMetadata = child.constructor.getMetadata(),
			slotName = this.constructor._getSlotName(child), // all slotted children have the same configuration
			childProperties = childMetadata.getProperties();

		let observedProps = [],
			notObservedProps = [];

		if (!listenFor) {
			return;
		}

		if (Array.isArray(listenFor)) {
			observedProps = listenFor;
		} else {
			observedProps = Array.isArray(listenFor.props) ? listenFor.props : Object.keys(childProperties);
			notObservedProps = Array.isArray(listenFor.exclude) ? listenFor.exclude : [];
		}

		if (!this._monitoredChildProps.has(slotName)) {
			this._monitoredChildProps.set(slotName, { observedProps, notObservedProps });
		}

		child.addEventListener("_propertyChange", this._invalidateParentOnPropertyUpdate);
	}

	/**
	 * @private
	 */
	_detachChildPropertyUpdated(child) {
		child.removeEventListener("_propertyChange", this._invalidateParentOnPropertyUpdate);
	}

	/**
	 * @private
	 */
	_propertyChange(name, value) {
		this._updateAttribute(name, value);

		const customEvent = new CustomEvent("_propertyChange", {
			detail: { name, newValue: value },
			composed: false,
			bubbles: true,
		});

		this.dispatchEvent(customEvent);
	}

	/**
	 * @private
	 */
	_invalidateParentOnPropertyUpdate(prop) {
		// The web component to be invalidated
		const parentNode = this.parentNode;
		if (!parentNode) {
			return;
		}

		const slotName = parentNode.constructor._getSlotName(this);
		const propsMetadata = parentNode._monitoredChildProps.get(slotName);

		if (!propsMetadata) {
			return;
		}
		const { observedProps, notObservedProps } = propsMetadata;

		if (observedProps.includes(prop.detail.name) && !notObservedProps.includes(prop.detail.name)) {
			parentNode._invalidate("_parent_", this);
		}
	}

	/**
	 * Asynchronously re-renders an already rendered web component
	 * @private
	 */
	_invalidate() {
		if (this._invalidated) {
			// console.log("already invalidated", this, ...arguments);
			return;
		}

		if (this.getDomRef() && !this._suppressInvalidation) {
			this._invalidated = true;
			// console.log("INVAL", this, ...arguments);
			RenderScheduler.renderDeferred(this);
		}
	}

	/**
	 * Do not call this method directly, only intended to be called by RenderScheduler.js
	 * @protected
	 */
	_render() {
		// suppress invalidation to prevent state changes scheduling another rendering
		this._suppressInvalidation = true;

		if (typeof this.onBeforeRendering === "function") {
			this.onBeforeRendering();
		}

		// Intended for framework usage only. Currently ItemNavigation updates tab indexes after the component has updated its state but before the template is rendered
		if (this._onComponentStateFinalized) {
			this._onComponentStateFinalized();
		}

		// resume normal invalidation handling
		delete this._suppressInvalidation;

		// Update the shadow root with the render result
		// console.log(this.getDomRef() ? "RE-RENDER" : "FIRST RENDER", this);
		delete this._invalidated;
		this._updateShadowRoot();

		if (this.constructor._needsStaticArea()) {
			this.staticAreaItem._updateFragment(this);
		}

		// Safari requires that children get the slot attribute only after the slot tags have been rendered in the shadow DOM
		this._assignIndividualSlotsToChildren();

		// Call the onAfterRendering hook
		if (typeof this.onAfterRendering === "function") {
			this.onAfterRendering();
		}
	}

	/**
	 * @private
	 */
	_updateShadowRoot() {
		let styleToPrepend;
		const renderResult = this.constructor.template(this);

		if (!document.adoptedStyleSheets && !window.ShadyDOM) {
			styleToPrepend = getEffectiveStyle(this.constructor);
		}
		this.constructor.render(renderResult, this.shadowRoot, styleToPrepend, { eventContext: this });
	}

	/**
	 * @private
	 */
	_assignIndividualSlotsToChildren() {
		const domChildren = Array.from(this.children);

		domChildren.forEach(child => {
			if (child._individualSlot) {
				child.setAttribute("slot", child._individualSlot);
			}
		});
	}

	/**
	 * @private
	 */
	_waitForDomRef() {
		return this._domRefReadyPromise;
	}

	/**
	 * Returns the DOM Element inside the Shadow Root that corresponds to the opening tag in the UI5 Web Component's template
	 * Use this method instead of "this.shadowRoot" to read the Shadow DOM, if ever necessary
	 * @public
	 */
	getDomRef() {
		if (!this.shadowRoot || this.shadowRoot.children.length === 0) {
			return;
		}

		return this.shadowRoot.children.length === 1
			? this.shadowRoot.children[0] : this.shadowRoot.children[1];
	}

	/**
	 * Returns the DOM Element marked with "data-sap-focus-ref" inside the template.
	 * This is the element that will receive the focus by default.
	 * @public
	 */
	getFocusDomRef() {
		const domRef = this.getDomRef();
		if (domRef) {
			const focusRef = domRef.querySelector("[data-sap-focus-ref]");
			return focusRef || domRef;
		}
	}

	/**
	 * Set the focus to the element, returned by "getFocusDomRef()" (marked by "data-sap-focus-ref")
	 * @public
	 */
	async focus() {
		await this._waitForDomRef();

		const focusDomRef = this.getFocusDomRef();

		if (focusDomRef && typeof focusDomRef.focus === "function") {
			focusDomRef.focus();
		}
	}

	/**
	 *
	 * @public
	 * @param name - name of the event
	 * @param data - additional data for the event
	 * @param cancelable - true, if the user can call preventDefault on the event object
	 * @returns {boolean} false, if the event was cancelled (preventDefault called), true otherwise
	 */
	fireEvent(name, data, cancelable) {
		let compatEventResult = true; // Initialized to true, because if the event is not fired at all, it should be considered "not-prevented"

		const noConflictEvent = new CustomEvent(`ui5-${name}`, {
			detail: data,
			composed: false,
			bubbles: true,
			cancelable,
		});

		// This will be false if the compat event is prevented
		compatEventResult = this.dispatchEvent(noConflictEvent);

		if (skipOriginalEvent(name)) {
			return compatEventResult;
		}

		const customEvent = new CustomEvent(name, {
			detail: data,
			composed: false,
			bubbles: true,
			cancelable,
		});

		// This will be false if the normal event is prevented
		const normalEventResult = this.dispatchEvent(customEvent);

		// Return false if any of the two events was prevented (its result was false).
		return normalEventResult && compatEventResult;
	}

	/**
	 * Returns the actual children, associated with a slot.
	 * Useful when there are transitive slots in nested component scenarios and you don't want to get a list of the slots, but rather of their content.
	 * @public
	 */
	getSlottedNodes(slotName) {
		const reducer = (acc, curr) => {
			if (curr.localName !== "slot") {
				return acc.concat([curr]);
			}
			return acc.concat(curr.assignedNodes({ flatten: true }).filter(item => item instanceof HTMLElement));
		};

		return this[slotName].reduce(reducer, []);
	}

	get isCompact() {
		return getComputedStyle(this).getPropertyValue(GLOBAL_CONTENT_DENSITY_CSS_VAR) === "compact";
	}

	updateStaticAreaItemContentDensity() {
		if (this.staticAreaItem) {
			this.staticAreaItem._updateContentDensity(this.isCompact);
		}
	}

	/**
	 * Used to duck-type UI5 elements without using instanceof
	 * @returns {boolean}
	 * @public
	 */
	get isUI5Element() {
		return true;
	}

	/**
	 * Do not override this method in derivatives of UI5Element, use metadata properties instead
	 * @private
	 */
	static get observedAttributes() {
		return this.getMetadata().getAttributesList();
	}

	/**
	 * Used to generate the next auto-increment id for the current class
	 * @returns {string}
	 * @private
	 */
	static _nextID() {
		const className = kebabToCamelCase(this.getMetadata().getTag());
		const lastNumber = IDMap.get(className);
		const nextNumber = lastNumber !== undefined ? lastNumber + 1 : 1;
		IDMap.set(className, nextNumber);
		return `__${className}${nextNumber}`;
	}

	/**
	 * @private
	 */
	static _getSlotName(child) {
		// Text nodes can only go to the default slot
		if (!(child instanceof HTMLElement)) {
			return "default";
		}

		// Discover the slot based on the real slot name (f.e. footer => footer, or content-32 => content)
		const slot = child.getAttribute("slot");
		if (slot) {
			const match = slot.match(/^(.+?)-\d+$/);
			return match ? match[1] : slot;
		}

		// Use default slot as a fallback
		return "default";
	}

	/**
	 * @private
	 */
	static _needsShadowDOM() {
		return !!this.template;
	}

	/**
	 * @private
	 */
	static _needsStaticArea() {
		return typeof this.staticAreaTemplate === "function";
	}

	/**
	 * @public
	 */
	getStaticAreaItemDomRef() {
		return this.staticAreaItem.getDomRef();
	}

	/**
	 * @private
	 */
	static _getDefaultState() {
		if (this._defaultState) {
			return this._defaultState;
		}

		const MetadataClass = this.getMetadata();
		const defaultState = {};

		// Initialize properties
		const props = MetadataClass.getProperties();
		for (const propName in props) { // eslint-disable-line
			const propType = props[propName].type;
			const propDefaultValue = props[propName].defaultValue;

			if (propType === Boolean) {
				defaultState[propName] = false;

				if (propDefaultValue !== undefined) {
					console.warn("The 'defaultValue' metadata key is ignored for all booleans properties, they would be initialized with 'false' by default"); // eslint-disable-line
				}
			} else if (props[propName].multiple) {
				defaultState[propName] = [];
			} else if (propType === Object) {
				defaultState[propName] = "defaultValue" in props[propName] ? props[propName].defaultValue : {};
			} else if (propType === String) {
				defaultState[propName] = "defaultValue" in props[propName] ? props[propName].defaultValue : "";
			} else {
				defaultState[propName] = propDefaultValue;
			}
		}

		// Initialize slots
		const slots = MetadataClass.getSlots();
		for (const [slotName, slotData] of Object.entries(slots)) { // eslint-disable-line
			const propertyName = slotData.propertyName || slotName;
			defaultState[propertyName] = [];
		}

		this._defaultState = defaultState;
		return defaultState;
	}

	/**
	 * @private
	 */
	static _generateAccessors() {
		const proto = this.prototype;

		// Properties
		const properties = this.getMetadata().getProperties();
		for (const [prop, propData] of Object.entries(properties)) { // eslint-disable-line
			if (!isValidPropertyName(prop)) {
				throw new Error(`"${prop}" is not a valid property name. Use a name that does not collide with DOM APIs`);
			}

			if (propData.type === "boolean" && propData.defaultValue) {
				throw new Error(`Cannot set a default value for property "${prop}". All booleans are false by default.`);
			}

			Object.defineProperty(proto, prop, {
				get() {
					if (this._state[prop] !== undefined) {
						return this._state[prop];
					}

					const propDefaultValue = propData.defaultValue;

					if (propData.type === Boolean) {
						return false;
					} else if (propData.type === String) {  // eslint-disable-line
						return propDefaultValue;
					} else if (propData.multiple) { // eslint-disable-line
						return [];
					} else {
						return propDefaultValue;
					}
				},
				set(value) {
					value = this.constructor.getMetadata().constructor.validatePropertyValue(value, propData);

					const oldState = this._state[prop];

					if (oldState !== value) {
						this._state[prop] = value;
						this._invalidate(prop, value);
						this._propertyChange(prop, value);
					}
				},
			});
		}

		// Slots
		const slots = this.getMetadata().getSlots();
		for (const [slotName, slotData] of Object.entries(slots)) { // eslint-disable-line
			if (!isValidPropertyName(slotName)) {
				throw new Error(`"${slotName}" is not a valid property name. Use a name that does not collide with DOM APIs`);
			}

			const propertyName = slotData.propertyName || slotName;
			Object.defineProperty(proto, propertyName, {
				get() {
					if (this._state[propertyName] !== undefined) {
						return this._state[propertyName];
					}
					return [];
				},
				set() {
					throw new Error("Cannot set slots directly, use the DOM APIs");
				},
			});
		}
	}

	/**
	 * Returns the metadata object for this UI5 Web Component Class
	 * @protected
	 */
	static get metadata() {
		return metadata;
	}

	/**
	 * Returns the CSS for this UI5 Web Component Class
	 * @protected
	 */
	static get styles() {
		return "";
	}

	/**
	 * Registers a UI5 Web Component in the browser window object
	 * @public
	 * @returns {Promise<UI5Element>}
	 */
	static async define() {
		await boot();

		if (this.onDefine) {
			await this.onDefine();
		}

		const tag = this.getMetadata().getTag();

		const definedLocally = DefinitionsSet.has(tag);
		const definedGlobally = customElements.get(tag);

		if (definedGlobally && !definedLocally) {
			console.warn(`Skipping definition of tag ${tag}, because it was already defined by another instance of ui5-webcomponents.`); // eslint-disable-line
		} else if (!definedGlobally) {
			this._generateAccessors();
			DefinitionsSet.add(tag);
			window.customElements.define(tag, this);
		}
		return this;
	}

	/**
	 * Returns an instance of UI5ElementMetadata.js representing this UI5 Web Component's full metadata (its and its parents')
	 * Note: not to be confused with the "get metadata()" method, which returns an object for this class's metadata only
	 * @public
	 * @returns {UI5ElementMetadata}
	 */
	static getMetadata() {
		if (this.hasOwnProperty("_metadata")) { // eslint-disable-line
			return this._metadata;
		}

		const metadataObjects = [this.metadata];
		let klass = this; // eslint-disable-line
		while (klass !== UI5Element) {
			klass = Object.getPrototypeOf(klass);
			metadataObjects.unshift(klass.metadata);
		}
		const mergedMetadata = merge({}, ...metadataObjects);

		this._metadata = new UI5ElementMetadata(mergedMetadata);
		return this._metadata;
	}
}

export default UI5Element;
