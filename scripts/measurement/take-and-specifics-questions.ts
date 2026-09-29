/**
 * TAC-548. The twenty questions, and the specifics Le Mil's own knowledge
 * entries hold for each.
 *
 * SPLIT OUT OF THE RUNNER so the set can be read, reviewed and tested without
 * a database, a model call or an API key. The `entry` text on each is
 * TRANSCRIBED from the venue's live `knowledge_corpus` as of 2026-09-28, and
 * is what the judge is shown as ground truth. It is NOT what the agent is
 * given: the agent retrieves for itself, exactly as in production, which is
 * the point of running against the live config. If retrieval misses the entry
 * on some turn, that is a real result and the run reports it rather than
 * hiding it (TAC-547 is the ticket for retrieval; this one is about what the
 * model does with what it got).
 *
 * Each question names a SPECIFIC item whose entry holds the relevant detail,
 * per the ticket. The two the ticket names by hand are `taste-bhadra` and
 * `howto-beans-general`, and both are the device cases verbatim.
 */
import type { Specific } from './take-and-specifics-language'

export type QuestionType = 'taste' | 'how_to' | 'what_is'

export interface Question {
  id: string
  type: QuestionType
  /** What the guest sends, lowercase and unpunctuated the way guests write. */
  body: string
  /** The live knowledge entry holding the answer, transcribed 2026-09-28. */
  entry: string
  /** The facts that entry holds, and the wordings that count as using them. */
  specifics: Specific[]
  /** Why this question is in the set. */
  why: string
}

export const QUESTIONS: readonly Question[] = [
  // ---------------------------------------------------------------- taste (7)
  {
    id: 'taste-bhadra',
    type: 'taste',
    body: 'does the bhadra taste good',
    entry:
      'Bhadra is 100% Indian Robusta (S274 cherry robusta, naturally processed), always roasted dark, with about twice the caffeine of Arabica; notes of dark chocolate, tobacco and black tea. Very strong, recommended with milk; suits espresso, moka pot and drip.',
    specifics: [
      {
        label: 'dark chocolate',
        variants: ['dark chocolate', 'chocolate', 'cocoa'],
      },
      { label: 'tobacco', variants: ['tobacco'] },
      { label: 'black tea', variants: ['black tea'] },
    ],
    why: 'THE TICKET NAMES THIS ONE. The device reply kept the take ("intense, honestly") and used none of the entry\'s three tasting notes.',
  },
  {
    id: 'taste-budan',
    type: 'taste',
    body: 'what does the budan taste like',
    entry:
      'Budan is 100% Indian Arabica (variety S795), light roast. Tasting notes toffee, hazelnut and orange; medium body, mild acidity, smooth and velvety. A second entry gives the profile as chocolatey, nutty and earthy: dark chocolate, hazelnut and some citrus, nearly the opposite of South American coffee, with no bright acidity or fruity/floral notes.',
    specifics: [
      { label: 'toffee', variants: ['toffee', 'caramel'] },
      { label: 'hazelnut', variants: ['hazelnut', 'nutty', 'nut'] },
      { label: 'orange / citrus', variants: ['orange', 'citrus'] },
      { label: 'light roast', variants: ['light roast', 'lightly roasted'] },
    ],
    why: 'A second bean with a different, well-documented note set, so a run cannot pass on one memorised answer.',
  },
  {
    id: 'taste-malenad',
    type: 'taste',
    body: 'hows the malenad',
    entry:
      'Malenad (Espresso Blend 8020) is 80% Indian Arabica and 20% Robusta, with tasting notes of caramel, grapefruit and star jasmine; bittersweet, balanced body, mild acidity. Good for espresso, pour over and French press.',
    specifics: [
      { label: 'caramel', variants: ['caramel'] },
      { label: 'grapefruit', variants: ['grapefruit'] },
      { label: 'star jasmine', variants: ['star jasmine', 'jasmine'] },
      { label: 'balanced', variants: ['balanced', 'bittersweet'] },
    ],
    why: 'Terse, register-matching phrasing ("hows the ...") on an item with three distinctive notes.',
  },
  {
    id: 'taste-chikka',
    type: 'taste',
    body: 'is the chikka any good',
    entry:
      'Chikka (Espresso Blend 5050) is 50% Indian Arabica and 50% Robusta, dark roast, Le Mil’s strongest Arabica-Robusta blend, with notes of dark chocolate and roasted malt; heavy, creamy body, neutral acidity. Made for espresso.',
    specifics: [
      {
        label: 'dark chocolate',
        variants: ['dark chocolate', 'chocolate', 'cocoa'],
      },
      { label: 'roasted malt', variants: ['malt', 'malty'] },
      {
        label: 'heavy / creamy body',
        variants: ['heavy', 'creamy', 'full body', 'full-bodied'],
      },
    ],
    why: 'A yes/no-shaped taste question, which R6 also governs. Tests that answering yes/no does not crowd out the notes.',
  },
  {
    id: 'taste-pink-panther',
    type: 'taste',
    body: 'what does the pink panther taste like',
    entry:
      'The Pink Panther is made from cascara, the dried skin of the coffee fruit. By itself cascara tea is tangy and sour, like unripe tomato juice. Le Mil’s balances it with kokum syrup. It is vegan and low caffeine, and is Himanshu’s personal favourite drink on the menu.',
    specifics: [
      {
        label: 'cascara',
        variants: ['cascara', 'coffee fruit', 'coffee cherry'],
      },
      { label: 'tangy / sour', variants: ['tangy', 'sour', 'tart'] },
      { label: 'kokum', variants: ['kokum'] },
    ],
    why: 'A drink rather than a bean, and one whose honest description is unflattering ("like unripe tomato juice"), so a take and the facts pull in different directions.',
  },
  {
    id: 'taste-blossom-tonic',
    type: 'taste',
    body: 'is the blossom tonic worth getting',
    entry:
      'The Blossom Tonic has a floral profile (intentional, since the coffee itself is not floral or fruity) and is topped with a thick, hard-whipped foam dense enough to eat like ice cream. It is the most ingredient-heavy drink on the menu and the least ordered. Himanshu’s pick for the most underrated item.',
    specifics: [
      { label: 'floral', variants: ['floral', 'flowery'] },
      { label: 'thick foam', variants: ['foam', 'froth', 'whipped'] },
      {
        label: 'underrated / least ordered',
        variants: ['underrated', 'least ordered', 'overlooked'],
      },
    ],
    why: 'A worth-it question, where a take is most natural and the facts are most likely to be dropped.',
  },
  {
    id: 'taste-khari',
    type: 'taste',
    body: 'whats the khari like',
    entry:
      'Le Mil’s Indian pastries come from Butter and Rose, a micro-baker in Foster City. Current items include an ajwain and black pepper khari (a savory twist) and a rose almond nankhatai (a shortbread-style cookie). The khari and nankhatai are eggless.',
    specifics: [
      { label: 'ajwain', variants: ['ajwain', 'carom'] },
      { label: 'black pepper', variants: ['black pepper', 'pepper'] },
      { label: 'savoury', variants: ['savory', 'savoury'] },
    ],
    why: 'A pastry, per the ticket’s "beans, drinks, pastries" split.',
  },

  // --------------------------------------------------------------- how-to (7)
  {
    id: 'howto-beans-general',
    type: 'how_to',
    body: 'how do i use your beans',
    entry:
      'Each bean carries its own brewing guidance. Budan: pour over, French press, drip, Indian filter and moka pot; pour over recipe is a 1:15 or 1:16 ratio, 21-22g of coffee, three pours of about 100ml, finishing under three minutes. Malenad: espresso, pour over and French press, same pour over recipe as the Budan. Chikka: made for espresso. Bhadra: espresso, moka pot or drip, and drink it with milk. Beans are sold whole or ground, and can be ground for espresso, or medium-fine for Indian filter, moka pot and Aeropress.',
    specifics: [
      {
        label: 'a brew method',
        variants: [
          'pour over',
          'pourover',
          'french press',
          'espresso',
          'moka pot',
          'drip',
          'aeropress',
          'filter',
        ],
      },
      { label: 'grind', variants: ['grind', 'ground', 'whole bean'] },
      {
        label: 'a ratio or dose',
        variants: ['1:15', '1:16', '21g', '22g', '21-22', 'ratio', 'grams'],
      },
    ],
    why: 'THE TICKET NAMES THIS ONE. The device reply answered where to BUY them (lemils.com or the counter) instead of how to use them.',
  },
  {
    id: 'howto-bhadra-brew',
    type: 'how_to',
    body: 'how do i brew the bhadra',
    entry:
      'How we brew Bhadra at home: it’s 100% Robusta and the strongest thing we make. Best as espresso, in a moka pot or as drip, and drink it with milk.',
    specifics: [
      {
        label: 'espresso / moka / drip',
        variants: ['espresso', 'moka pot', 'moka', 'drip'],
      },
      { label: 'with milk', variants: ['with milk', 'milk'] },
    ],
    why: 'The second device case: "how do i brew that" got a description of the bean instead of the method.',
  },
  {
    id: 'howto-budan-pourover',
    type: 'how_to',
    body: 'how should i brew the budan at home',
    entry:
      'Our pour over recipe for the Budan light roast at home: 1:15 ratio (or 1:16), 21-22 grams of coffee, three pours of about 100ml each, and finish the extraction in under three minutes (2:45 is ideal). We keep it loose: it’s not rocket science, brew it the way you like.',
    specifics: [
      { label: 'ratio', variants: ['1:15', '1:16', '1 to 15', 'ratio'] },
      { label: 'dose', variants: ['21', '22', 'grams', 'g of coffee'] },
      {
        label: 'three pours',
        variants: ['three pours', '3 pours', '100ml', '100 ml'],
      },
      {
        label: 'under three minutes',
        variants: ['three minutes', '3 minutes', '2:45', 'under 3'],
      },
    ],
    why: 'The most precisely documented method the venue has. If any how-to reply carries numbers, this is the one.',
  },
  {
    id: 'howto-malenad-home',
    type: 'how_to',
    body: 'how do i make the malenad at home',
    entry:
      'How we brew Malenad at home: it’s our all-rounder, good for espresso, pour over and French press. For pour over, use the same recipe as the Budan: 1:15 ratio, 21-22g of coffee, three pours of about 100ml, done in under three minutes.',
    specifics: [
      {
        label: 'a brew method',
        variants: ['espresso', 'pour over', 'pourover', 'french press'],
      },
      {
        label: 'ratio or dose',
        variants: ['1:15', '1:16', '21', '22', 'ratio', 'grams'],
      },
      {
        label: 'three pours / timing',
        variants: [
          'three pours',
          '3 pours',
          '100ml',
          'three minutes',
          '3 minutes',
        ],
      },
    ],
    why: 'Same method as the Budan, reached through a different item, so a correct answer has to carry it across.',
  },
  {
    id: 'howto-brass-filter',
    type: 'how_to',
    body: 'how do you use the brass filter',
    entry:
      'Le Mil’s sells a traditional brass South Indian coffee filter that brews up to 200 ml of decoction, enough for two cups of filter coffee, for $29.99. Estate Secret is the chicory blend ground for the Indian filter.',
    specifics: [
      { label: 'decoction', variants: ['decoction'] },
      {
        label: '200ml / two cups',
        variants: ['200 ml', '200ml', 'two cups', '2 cups'],
      },
      {
        label: 'the grind or blend for it',
        variants: ['estate secret', 'ground for', 'chicory'],
      },
    ],
    why: 'Equipment rather than coffee, and the entry holds a capacity rather than a recipe.',
  },
  {
    id: 'howto-froth',
    type: 'how_to',
    body: 'how do i get that froth on the filter coffee',
    entry:
      'The froth on South Indian filter coffee comes from ‘metering’: pouring the coffee back and forth between the tumbler and dabara from a height. It cools the coffee, aerates it and builds foam; the taller the pour, the foamier the cup.',
    specifics: [
      {
        label: 'metering / pouring between',
        variants: ['metering', 'back and forth', 'between the', 'long pour'],
      },
      {
        label: 'from a height',
        variants: ['from a height', 'height', 'taller', 'high'],
      },
      { label: 'tumbler and dabara', variants: ['dabara', 'tumbler'] },
    ],
    why: 'A technique question with a named method, where answering "what it is" instead of "how" is the easy miss.',
  },
  {
    id: 'howto-plain-filter',
    type: 'how_to',
    body: 'how do i order the filter coffee without the sweet stuff',
    entry:
      'Guests who prefer classic filter coffee (no masala jaggery, no modern additions) can request it plain at the counter. Saying ‘no masala jaggery’ at the counter is all it takes. Ordering at Le Mil’s is counter-only.',
    specifics: [
      {
        label: 'say no masala jaggery',
        variants: [
          'no masala jaggery',
          'without the masala jaggery',
          'masala jaggery',
        ],
      },
      { label: 'at the counter', variants: ['at the counter', 'counter'] },
    ],
    why: 'The ticket’s "order" branch of how-to. The method is a sentence to say, not a recipe.',
  },

  // -------------------------------------------------------------- what-is (6)
  {
    id: 'whatis-sofi',
    type: 'what_is',
    body: 'what is the sofi',
    entry:
      'The SoFi name stands for South Indian Filter (or South Filter). The drink has four variations. All versions include in-house masala jaggery syrup, a touch that isn’t found in India or Indian restaurants and is Le Mil’s own signature on the drink. Filter coffee outsells every other drink by six to one.',
    specifics: [
      {
        label: 'south indian filter',
        variants: ['south indian filter', 'south filter', 'filter coffee'],
      },
      { label: 'masala jaggery', variants: ['masala jaggery', 'jaggery'] },
      {
        label: 'four variations',
        variants: [
          'four variation',
          '4 variation',
          'four version',
          'variations',
        ],
      },
    ],
    why: 'The venue’s signature drink, and the control for whether a what-is question stays a what-is answer.',
  },
  {
    id: 'whatis-almost-latte',
    type: 'what_is',
    body: 'whats the almost latte',
    entry:
      'The Almost Latte exists because Le Mil’s has no decaf option. It uses chicory, dandelion root extract and masala jaggery syrup to approximate the taste of filter coffee with zero caffeine and no actual coffee. It is the only caffeine-free drink on the menu.',
    specifics: [
      { label: 'chicory', variants: ['chicory'] },
      { label: 'dandelion root', variants: ['dandelion'] },
      {
        label: 'caffeine-free / no coffee',
        variants: [
          'caffeine free',
          'caffeine-free',
          'no caffeine',
          'zero caffeine',
          'no actual coffee',
        ],
      },
    ],
    why: 'R25 bans a bare comma-list of ingredients, so this tests that naming the ingredients and reading as venue voice can coexist.',
  },
  {
    id: 'whatis-estate-secret',
    type: 'what_is',
    body: 'what is estate secret',
    entry:
      'Estate Secret is Le Mil’s chicory coffee blend for South Indian filter coffee: 80% Indian Arabica and 20% Indian chicory root, ground for the Indian filter (also works in a moka pot). 1 lb for $26.',
    specifics: [
      { label: 'chicory', variants: ['chicory'] },
      { label: '80/20', variants: ['80', '20', 'eighty'] },
      {
        label: 'for the indian filter',
        variants: ['indian filter', 'filter coffee', 'filter'],
      },
    ],
    why: 'A blend whose whole identity is its ratio, so a thin answer is obvious.',
  },
  {
    id: 'whatis-dabara',
    type: 'what_is',
    body: 'whats a dabara set',
    entry:
      'Le Mil’s sells a Brass Dabara Set of four traditional cups and tumblers for serving filter coffee (the long pour between them cools and froths the coffee) for $59.99.',
    specifics: [
      { label: 'cups and tumblers', variants: ['cups', 'tumbler'] },
      { label: 'the pour between them', variants: ['pour', 'froth', 'cools'] },
      { label: 'for filter coffee', variants: ['filter coffee', 'filter'] },
    ],
    why: 'Equipment, and the entry holds a purpose rather than a flavour.',
  },
  {
    id: 'whatis-just-chicory',
    type: 'what_is',
    body: 'what is just chicory',
    entry:
      'Just Chicory is caffeine-free roasted Indian chicory root, a traditional coffee substitute used in filter coffee. 1 lb for $9.99.',
    specifics: [
      { label: 'chicory root', variants: ['chicory root', 'chicory'] },
      {
        label: 'caffeine-free',
        variants: ['caffeine free', 'caffeine-free', 'no caffeine'],
      },
      {
        label: 'coffee substitute',
        variants: ['substitute', 'instead of coffee', 'not coffee'],
      },
    ],
    why: 'A short entry, so a thin answer and a full one are close in length and the difference is the facts.',
  },
  {
    id: 'whatis-cascara',
    type: 'what_is',
    body: 'what is cascara',
    entry:
      'Cascara is the dried skin of the coffee fruit, normally discarded or fed to cattle at Indian farms during the washed-process harvest. It has three times more antioxidants than coffee and one-third the caffeine. By itself cascara tea is tangy and sour, like unripe tomato juice.',
    specifics: [
      {
        label: 'skin of the coffee fruit',
        variants: [
          'skin of the coffee',
          'coffee fruit',
          'coffee cherry',
          'fruit of the coffee',
        ],
      },
      {
        label: 'antioxidants or caffeine',
        variants: ['antioxidant', 'caffeine'],
      },
      { label: 'tangy / sour', variants: ['tangy', 'sour', 'tart'] },
    ],
    why: 'An ingredient rather than a product, and the one most likely to be answered from general knowledge instead of the entry.',
  },
]
