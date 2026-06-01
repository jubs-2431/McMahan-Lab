# Split/Steal Avatar Study Script

## Purpose

This script gives a consistent process for running participant sessions with the 3D avatar Split/Steal website. Use the same wording and steps for each participant so the interaction is comparable across sessions.

## Materials

- Laptop with the site running: `http://127.0.0.1:8012/`
- Male avatar URL: `http://127.0.0.1:8012/?avatar=male`
- Female avatar URL: `http://127.0.0.1:8012/?avatar=female`
- Browser with microphone permission enabled if voice interaction is being tested
- Notes sheet or spreadsheet for participant ID, avatar condition, choices, outcomes, and observations
- Optional screen recording or exported history if approved for the session

## Pre-Session Setup

1. Start the local server from the project folder.

   ```bash
   cd /Users/aryanshah/Downloads/finalAnim
   env WEB_APP_PORT=8012 ./run-local.sh
   ```

2. Open either the male or female avatar condition.
3. Confirm the avatar loads and the status says the avatar is ready.
4. Confirm the `Split`, `Steal`, `Scratch Head`, and `Scratch Cheek` buttons are visible.
5. Assign the participant a non-identifying ID, such as `P01`.
6. Record the avatar condition used for the session.
7. Do not ask for or enter the participant's name into the website. Use the participant ID only.

## Moderator Opening Script

Read this to the participant:

> Thank you for participating. In this session, you will interact with a 3D avatar in a short decision-making game called Split or Steal. The goal is to observe how people make choices when interacting with an animated conversational agent. There are no right or wrong answers. Please make choices naturally, as you would if you were actually playing with the avatar.

If recording or storing session data:

> The website may store the dialogue and the choices made during the session, including your choice, the avatar's choice, and the outcome of each round. We will use this only for research review and analysis. Please do not share private personal information with the avatar.

> We will use a participant ID instead of your name. The avatar should not ask for your name, and you do not need to provide it.

## Participant Instructions

Read this before starting the task:

> You will see two main game buttons: Split and Steal. For each round, choose one option. The avatar will choose its own option before it is told what you picked. After both choices are known, the avatar will say whether you won, the avatar won, it was a tie, or no one won.

Explain the game:

> If both choose Split, it is a tie. If one person chooses Steal while the other chooses Split, the person who chose Steal wins. If both choose Steal, no one wins.

Then say:

> Please play at least five rounds. After each round, briefly think about whether the avatar's appearance, voice, response, or behavior affected your next choice.

## Task Sequence

1. Ask the participant to look at the avatar for a few seconds before playing.
2. Ask: "What is your first impression of the avatar?"
3. Have the participant play five Split/Steal rounds.
4. After each round, record:
   - Participant choice: Split or Steal
   - Avatar choice: Split or Steal
   - Outcome: participant wins, avatar wins, tie, or no one wins
   - Any verbal reaction from the participant
5. If testing gestures, ask the participant to click `Scratch Head` and `Scratch Cheek`.
6. Ask whether the gestures made the avatar feel more natural, distracting, or unchanged.
7. If testing both avatar conditions, switch avatars and repeat the same five-round sequence.

## Optional Think-Aloud Prompt

Use this only if you want verbal reasoning during the session:

> As you play, please briefly say what you are thinking before you choose Split or Steal. For example, you can mention whether you trust the avatar, expect it to cooperate, or want to protect yourself from losing.

## Post-Task Questions

Ask these after the game:

1. What made you choose Split or Steal in most rounds?
2. Did the avatar's response affect your next choice?
3. Did the avatar feel trustworthy, competitive, neutral, or unpredictable?
4. Did the voice or facial animation affect how you interpreted the avatar?
5. Did the scratch gestures make the avatar feel more realistic?
6. If you saw both avatars, did the male and female avatars change how you made decisions?
7. What would make the interaction feel more natural or believable?

## Debrief Script

Read this at the end:

> Thank you. This session was designed to study how people respond to a conversational 3D avatar during a simple decision-making game. We are especially interested in how avatar appearance, voice, animation, and game outcome influence trust and choice behavior. Your responses will help improve the interaction design and research procedure.

## Data to Save

For each session, save or record:

- Participant ID
- Do not record participant name in the chat log
- Date and time
- Avatar condition: male, female, or both
- Number of rounds played
- Participant choices
- Avatar choices
- Outcomes
- Short notes on participant reactions
- Any technical issues, such as model loading, audio, microphone permission, or lag

The app stores browser-side dialogue in `localStorage`. The Flask server also stores in-memory session dialogue and Split/Steal rounds while the server is running. Use:

```text
http://127.0.0.1:8012/api/history/<session_id>
```

Replace `<session_id>` with the session ID used by the browser or test run.
