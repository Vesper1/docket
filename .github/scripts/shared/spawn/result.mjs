export const completedStatus = (result, command) => {
	if (result.error) {
		throw result.error;
	}

	if (result.status === null) {
		throw new Error(
			`${command} terminated with signal ${result.signal ?? 'unknown'}`,
		);
	}

	return result.status;
};
