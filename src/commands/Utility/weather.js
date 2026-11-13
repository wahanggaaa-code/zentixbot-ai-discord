import { SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { LookupError, LookupFailure, codeSpan, getJson, lookupFailureMessage, plainText } from '../../services/searchLookup.js';

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const SERVICE = 'The weather service';

// WMO weather interpretation codes, as Open-Meteo reports them.
const CONDITIONS = new Map([
    [0, 'Clear sky'], [1, 'Mainly clear'], [2, 'Partly cloudy'], [3, 'Overcast'],
    [45, 'Fog'], [48, 'Depositing rime fog'],
    [51, 'Light drizzle'], [53, 'Moderate drizzle'], [55, 'Dense drizzle'],
    [56, 'Light freezing drizzle'], [57, 'Dense freezing drizzle'],
    [61, 'Slight rain'], [63, 'Moderate rain'], [65, 'Heavy rain'],
    [66, 'Light freezing rain'], [67, 'Heavy freezing rain'],
    [71, 'Slight snow fall'], [73, 'Moderate snow fall'], [75, 'Heavy snow fall'], [77, 'Snow grains'],
    [80, 'Slight rain showers'], [81, 'Moderate rain showers'], [82, 'Violent rain showers'],
    [85, 'Slight snow showers'], [86, 'Heavy snow showers'],
    [95, 'Thunderstorm'], [96, 'Thunderstorm with slight hail'], [99, 'Thunderstorm with heavy hail'],
]);

export const describeWeatherCode = (code) => CONDITIONS.get(code) ?? 'Conditions not reported';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

export default {
    data: new SlashCommandBuilder()
        .setName('weather')
        .setDescription('Get real-time weather information for a location')
        .addStringOption((option) =>
            option
                .setName('city')
                .setDescription("The city name, e.g., 'London' or 'Tokyo'")
                .setRequired(true)
                .setMinLength(2)
                .setMaxLength(100),
        ),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn('Weather interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId, commandName: 'weather' });
            return;
        }

        const city = String(interaction.options.getString('city') ?? '').trim();
        if (city.length < 2 || city.length > 100) {
            return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Please enter a city name of 2 to 100 characters.' });
        }

        let place;
        let current;
        try {
            const geoData = await getJson(`${GEOCODING_URL}?name=${encodeURIComponent(city)}`);
            place = Array.isArray(geoData.results) ? geoData.results.find((entry) => finite(entry?.latitude) && finite(entry?.longitude)) : null;
            if (!place) {
                logger.info('Weather command - city not found', { userId: interaction.user.id, guildId: interaction.guildId });
                return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: `Could not find a location for ${codeSpan(city)}. Please check the spelling.` });
            }

            const weatherData = await getJson(`${WEATHER_URL}?latitude=${place.latitude}&longitude=${place.longitude}&current_weather=true`);
            current = weatherData.current_weather ?? weatherData.current;
            // An answer without a temperature is not a weather report.
            const temperature = current?.temperature ?? current?.temperature_2m;
            if (weatherData.error || !finite(temperature)) throw new LookupError(LookupFailure.BAD_RESPONSE);
            current = { ...current, temperature };
        } catch (error) {
            if (!(error instanceof LookupError)) throw error;
            logger.warn(`Weather lookup failed: ${error.message}`, { userId: interaction.user.id, guildId: interaction.guildId, reason: error.reason });
            return await replyUserError(interaction, { type: ErrorTypes.NETWORK, message: lookupFailureMessage(error, SERVICE) });
        }

        const windSpeed = current.windspeed ?? current.wind_speed_10m;
        const humidity = current.relativehumidity ?? current.relative_humidity_2m;
        const where = [place.name, place.country].filter((part) => typeof part === 'string' && part.trim()).map((part) => plainText(part, 80)).join(', ');

        const fields = [{ name: 'Temperature', value: `${Math.round(current.temperature)}°C`, inline: true }];
        // The current request does not ask for humidity; the field appears only when a value arrives.
        if (finite(humidity)) fields.push({ name: 'Humidity', value: `${Math.round(humidity)}%`, inline: true });
        if (finite(windSpeed)) fields.push({ name: 'Wind Speed', value: `${Math.round(windSpeed)} km/h`, inline: true });

        const embed = createEmbed({
            title: `Weather in ${where || plainText(city, 100)}`,
            description: describeWeatherCode(current.weathercode ?? current.weather_code),
        })
            .addFields(fields)
            .setFooter({ text: `Latitude: ${place.latitude.toFixed(2)} | Longitude: ${place.longitude.toFixed(2)}` });

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        logger.info('Weather command executed', { userId: interaction.user.id, guildId: interaction.guildId });
    },
};
