import { BattleTrainer, clone, fail, TrainerTeam } from './pvp.types';

type Preset = Omit<BattleTrainer, 'presetId'> & { id: string };
// Compiled as a Nest asset, independent from the administrator's engine bundle.
const presets: Preset[] = require('./kantoPresets.json');

export function trainerPreset(presetId: unknown): BattleTrainer {
  const preset = presets.find((entry) => entry.id === presetId);
  if (!preset || preset.region !== 'kanto')
    fail('INVALID_TRAINER', 'Selecciona un Trainer disponible de Kanto.');
  const { id, ...data } = clone(preset);
  return { presetId: id, ...data };
}

/** Apply the board's HP scale without recalculating any human Pokemon. */
export function scaleTrainerTeam(
  trainer: BattleTrainer,
  hpMultiplier: number,
): TrainerTeam {
  const team = clone(trainer.team);
  for (const capture of team.pokemons) {
    const pokemon = capture.pokemon;
    pokemon.hpMultiplier = hpMultiplier;
    pokemon.stats = pokemon.baseStats.map(({ name, value }) => {
      const calculated =
        Math.floor((value * pokemon.level) / 50) +
        (name === 'hp' ? pokemon.level + 10 : 5);
      return {
        name,
        value:
          name === 'hp' ? Math.floor(calculated * hpMultiplier) : calculated,
      };
    });
  }
  return team;
}
