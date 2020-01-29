import { getAnimationMode as getConfiguredAnimationMode } from "../InitialConfiguration.js";

let animationMode;

const getAnimationMode = () => {
	if (animationMode === undefined) {
		getConfiguredAnimationMode();
	}

	return animationMode;
};

export { getAnimationMode }; // eslint-disable-line
