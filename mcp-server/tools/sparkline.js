/**
 * Sparkline utilities — Unicode block-character charts for terminal display.
 *
 * Uses the standard block elements: ▁▂▃▄▅▆▇█
 * Index 0 is a space (empty), index 8 is a full block.
 */

const BLOCKS = ' ▁▂▃▄▅▆▇█';

/**
 * Generate a sparkline string from an array of numbers.
 *
 * @param {number[]} values - Array of numeric values
 * @param {number} [width] - Max width in characters (default: values.length)
 * @returns {string} Sparkline string
 */
export function sparkline(values, width) {
  if (!values || values.length === 0) return '';

  // Down-sample if width is specified and smaller than values.length
  let data = values;
  if (width && width > 0 && width < values.length) {
    data = downsample(values, width);
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min;

  return data
    .map((v) => {
      if (range === 0) return BLOCKS[4]; // mid-height when all values are equal
      const idx = Math.round(((v - min) / range) * 8);
      return BLOCKS[idx];
    })
    .join('');
}

/**
 * Generate a mini bar chart with labels.
 * Example: "Mon ▃ Tue ▅ Wed ▇ Thu ▂ Fri ▄"
 *
 * @param {Array<{label: string, value: number}>} data
 * @returns {string}
 */
export function labeledSparkline(data) {
  if (!data || data.length === 0) return '';

  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  return data
    .map((d) => {
      let idx;
      if (range === 0) {
        idx = 4;
      } else {
        idx = Math.round(((d.value - min) / range) * 8);
      }
      return `${d.label} ${BLOCKS[idx]}`;
    })
    .join(' ');
}

/**
 * Format a cost trend line.
 * Example: "Cost (14d): ▂▃▂▅▇▃▂▁▃▄▂▅▃▂  avg $2.14/day  total $29.96"
 *
 * @param {Array<{date: string, total: number}>} dailyCosts - Daily cost aggregates
 * @returns {string}
 */
export function costTrendLine(dailyCosts) {
  if (!dailyCosts || dailyCosts.length === 0) return 'Cost: no data';

  const values = dailyCosts.map((d) => d.cost ?? d.total ?? 0);
  const days = values.length;
  const total = values.reduce((a, b) => a + b, 0);
  const avg = total / days;
  const spark = sparkline(values);

  return `Cost (${days}d): ${spark}  avg $${avg.toFixed(2)}/day  total $${total.toFixed(2)}`;
}

/**
 * Format a task volume trend line.
 * Example: "Tasks (14d): ▃▅▇▃▂▅▇▃▂▁▃▅▃▂  avg 4.2/day"
 *
 * @param {Array<{date: string, count: number}>} dailyCounts
 * @returns {string}
 */
export function taskTrendLine(dailyCounts) {
  if (!dailyCounts || dailyCounts.length === 0) return 'Tasks: no data';

  const values = dailyCounts.map((d) => d.count);
  const days = values.length;
  const total = values.reduce((a, b) => a + b, 0);
  const avg = total / days;
  const spark = sparkline(values);

  return `Tasks (${days}d): ${spark}  avg ${avg.toFixed(1)}/day`;
}

/**
 * Generate a progress bar using filled/empty block chars.
 * Example: "▰▰▰▰▰▰▱▱▱▱" for 60%
 *
 * @param {number} fraction - Value between 0 and 1
 * @param {number} [width=10] - Bar width in characters
 * @returns {string}
 */
export function progressBar(fraction, width = 10) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Down-sample an array to a target width using averaging.
 */
function downsample(values, width) {
  const result = [];
  const bucketSize = values.length / width;

  for (let i = 0; i < width; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < values.length; j++) {
      sum += values[j];
      count++;
    }
    result.push(count > 0 ? sum / count : 0);
  }

  return result;
}
