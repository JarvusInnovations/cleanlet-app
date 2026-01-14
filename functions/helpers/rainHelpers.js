export const MM_PER_INCH = 25.4;
export const RAIN_THRESHOLD_MM = 0.75 * MM_PER_INCH;

const parseValidTime = (validTime) => {
  const [startStr, durationStr] = validTime.split('/');

  const start = new Date(startStr);

  const hours = Number(durationStr.replace('PT', '').replace('H', ''));
  const end = new Date(start.getTime() + hours * 60 * 60 * 1000);

  return { start, end };
};

export const sumPrecipitationMM = (values, windowStart, windowEnd) => {
  let total = 0;

  for (const entry of values) {
    if (entry.value == null) continue;

    const { start, end } = parseValidTime(entry.validTime);

    const overlaps = start < windowEnd && end > windowStart;

    if (overlaps) {
      total += entry.value;
    }
  }

  return total;
};
