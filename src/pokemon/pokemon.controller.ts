import { Controller, Get, Post, Body, Patch, Param, Delete, HttpCode, Query } from '@nestjs/common';
import { PokemonService } from './pokemon.service';
import { CreatePokemonDto } from './dto/create-pokemon.dto';
import { UpdatePokemonDto } from './dto/update-pokemon.dto';
import { ParseMongoIdPipe } from 'src/common/pipes/parse-mongo-id/parse-mongo-id.pipe';
import { PaginationDto } from 'src/common/dto/pagination.dto';

@Controller('pokemon')
export class PokemonController {
  constructor(private readonly pokemonService: PokemonService) { }

  @Post()
  // @HttpCode(200) // ó @HttpCode(HttpStatus.OK) para usar el emun, usar ctrl click para verlos
  create(@Body() createPokemonDto: CreatePokemonDto) {
    return this.pokemonService.create(createPokemonDto);
  }

  @Get()
  findAll(@Query() paginationDto: PaginationDto) {
    // console.log({ paginationDto })    
    return this.pokemonService.findAll(paginationDto);
  }

  // termDbusqueda ya que puede ser un id o un mongoID o el nombre etc, en nest
  @Get(':termDbusqueda')
  findOne(@Param('termDbusqueda') termDbusqueda: string) {
    return this.pokemonService.findOne(termDbusqueda);
  }

  @Patch(':termDbusqueda')
  update(@Param('termDbusqueda') termDbusqueda: string, @Body() updatePokemonDto: UpdatePokemonDto) {
    return this.pokemonService.update(termDbusqueda, updatePokemonDto);
  }

  @Delete(':id')
  remove(@Param('id', ParseMongoIdPipe) id: string) {
    return this.pokemonService.remove(id);
  }
}
