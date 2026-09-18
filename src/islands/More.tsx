import type { Signal } from '@preact/signals';
import type { Timings, TopEntry } from '../lib/model';
import type { Backend } from '../lib/worker-protocol';

interface Props {
  temperature: Signal<number>;
  topK: Signal<number>;
  maskIllegal: Signal<boolean>;
  showArrows: Signal<boolean>;
  waterfall: Signal<Timings[]>;
  top5: Signal<TopEntry[]>;
  loadMs: Signal<number>;
  backend: Signal<Backend | null>;
}

function ms(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}

function total(timings: Timings): number {
  return timings.tokenizeMs + timings.inferMs + timings.sampleMs;
}

/**
 * The "más" drawer of `docs/05-web-demo.md`: everything that must not touch the single screen.
 * It ships closed and holds the sampling controls, the unmasked mode, the latency waterfall and
 * what the network actually proposed.
 */
export default function More({
  temperature,
  topK,
  maskIllegal,
  showArrows,
  waterfall,
  top5,
  loadMs,
  backend,
}: Props) {
  const rows = waterfall.value;
  const slowest = rows.reduce((max, row) => Math.max(max, total(row)), 1);

  return (
    <details class="drawer" data-testid="drawer">
      <summary class="drawer__summary">Más</summary>
      <div class="drawer__body">
        <section class="drawer__block" aria-labelledby="sampling-title">
          <h2 id="sampling-title" class="label">
            Muestreo
          </h2>
          <label class="drawer__field">
            <span class="caption">Temperatura · {temperature.value.toFixed(2)}</span>
            <input
              class="range"
              type="range"
              min="0"
              max="2"
              step="0.05"
              data-testid="temperature"
              value={String(temperature.value)}
              onInput={(event) =>
                (temperature.value = Number((event.currentTarget as HTMLInputElement).value))
              }
            />
          </label>
          <label class="drawer__field">
            <span class="caption">Top-k · {topK.value}</span>
            <input
              class="range"
              type="range"
              min="1"
              max="50"
              step="1"
              data-testid="top-k"
              value={String(topK.value)}
              onInput={(event) =>
                (topK.value = Number((event.currentTarget as HTMLInputElement).value))
              }
            />
          </label>
          <label class="drawer__toggle">
            <input
              type="checkbox"
              data-testid="unmasked"
              checked={!maskIllegal.value}
              onChange={(event) =>
                (maskIllegal.value = !(event.currentTarget as HTMLInputElement).checked)
              }
            />
            <span>
              Sin máscara
              <span class="caption"> · la jugada ilegal se marca en la lista, no se juega</span>
            </span>
          </label>
          <label class="drawer__toggle">
            <input
              type="checkbox"
              data-testid="arrows"
              checked={showArrows.value}
              onChange={(event) =>
                (showArrows.value = (event.currentTarget as HTMLInputElement).checked)
              }
            />
            <span>Flechas de las 5 mejores jugadas</span>
          </label>
        </section>

        <section class="drawer__block" aria-labelledby="latency-title">
          <h2 id="latency-title" class="label">
            Cascada de latencia
          </h2>
          {rows.length === 0 ? (
            <p class="caption">Aún no ha jugado el modelo.</p>
          ) : (
            <ol class="waterfall" data-testid="waterfall">
              {rows.map((row, index) => (
                <li class="waterfall__row" key={index} data-testid="waterfall-row">
                  <span class="waterfall__num caption">{rows.length - index}</span>
                  <progress class="bar" value={total(row)} max={slowest} />
                  <span class="waterfall__times caption">
                    <span data-testid="tokenize-ms">{ms(row.tokenizeMs)}</span>
                    {' → '}
                    <span data-testid="infer-ms">{ms(row.inferMs)}</span>
                    {' → '}
                    <span data-testid="sample-ms">{ms(row.sampleMs)}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
          {backend.value ? (
            <p class="caption">
              Sesión {backend.value === 'webgpu' ? 'WebGPU' : 'WASM'} lista en {loadMs.value} ms.
            </p>
          ) : null}
        </section>

        <section class="drawer__block" aria-labelledby="network-title">
          <h2 id="network-title" class="label">
            Qué ha salido por la red
          </h2>
          {top5.value.length === 0 ? (
            <p class="caption">Aún no ha jugado el modelo.</p>
          ) : (
            <ol class="top5" data-testid="top5">
              {top5.value.map((entry) => (
                <li class="top5__row" key={entry.uci} data-testid="top5-row">
                  <span class="top5__uci mono">{entry.uci}</span>
                  <progress class="bar" value={entry.prob} max={1} />
                  <span class="top5__prob caption">{(entry.prob * 100).toFixed(1)} %</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </details>
  );
}
